from collections.abc import Iterator

import pytest
from sqlalchemy.orm import Session

from app.database import engine


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
