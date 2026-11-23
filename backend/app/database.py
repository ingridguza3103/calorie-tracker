from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session

from app.config import database_url
from app.database_settings import database_connect_args

engine = create_engine(
    database_url,
    pool_pre_ping=True,
    connect_args=database_connect_args(database_url),
)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    """Provide one session per request; callers explicitly commit changes."""
    with Session(engine) as session:
        yield session
