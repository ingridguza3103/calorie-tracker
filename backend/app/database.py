from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session

from app.config import database_url

engine = create_engine(
    database_url,
    pool_pre_ping=True,
    connect_args={"connect_timeout": 3},
)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    """Provide one session per request; callers explicitly commit changes."""
    with Session(engine) as session:
        yield session
