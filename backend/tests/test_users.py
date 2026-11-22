from contextlib import closing
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import engine, get_db
from app.models import User


def make_user(username: str | None = None) -> User:
    return User(
        username=username or f"Test{uuid4().hex}",
        password_hash=f"fixture-hash-{uuid4().hex}",
    )


def test_user_can_be_saved_and_loaded(db_session: Session) -> None:
    user = make_user()
    expected_hash = user.password_hash
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    assert user.id > 0
    assert user.password_hash == expected_hash
    assert user.created_at.tzinfo is not None
    assert db_session.scalar(
        select(User).where(User.username == user.username)
    ) is user


def test_database_rejects_duplicate_usernames(db_session: Session) -> None:
    user = make_user()
    db_session.add(user)
    db_session.flush()

    with pytest.raises(IntegrityError):
        with db_session.begin_nested():
            db_session.add(make_user(user.username))
            db_session.flush()


def test_usernames_are_case_sensitive(db_session: Session) -> None:
    first = make_user()
    second = make_user(first.username.lower())
    db_session.add_all([first, second])
    db_session.flush()

    assert first.id != second.id


@pytest.mark.parametrize("field", ["username", "password_hash"])
def test_database_requires_account_fields(db_session: Session, field: str) -> None:
    user = make_user()
    setattr(user, field, None)

    with pytest.raises(IntegrityError):
        with db_session.begin_nested():
            db_session.add(user)
            db_session.flush()


def test_request_session_rolls_back_uncommitted_changes() -> None:
    user = make_user()
    username = user.username

    with closing(get_db()) as sessions:
        session = next(sessions)
        session.add(user)
        session.flush()

    with Session(engine) as session:
        assert session.scalar(
            select(User.id).where(User.username == username)
        ) is None
