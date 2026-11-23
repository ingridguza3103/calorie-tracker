from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app import config, main, rate_limit
from app.database import engine, get_db


@pytest.fixture
def db_session() -> Iterator[Session]:
    """Roll back each test, including changes committed inside its session."""
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            with Session(
                bind=connection,
                join_transaction_mode="create_savepoint",
            ) as session:
                yield session
        finally:
            transaction.rollback()


@pytest.fixture
def client(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    def override_db() -> Iterator[Session]:
        yield db_session

    monkeypatch.setattr(rate_limit, "auth_limiter", rate_limit.AuthRateLimiter(limit=100))
    monkeypatch.setattr(config, "ALLOWED_ORIGINS", frozenset({"http://127.0.0.1:5174"}))
    monkeypatch.setattr(config, "SESSION_COOKIE_SECURE", False)
    main.app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(
            main.app,
            headers={"Origin": "http://127.0.0.1:5174", "X-CSRF-Protection": "1"},
        ) as api_client:
            yield api_client
    finally:
        main.app.dependency_overrides.pop(get_db, None)
