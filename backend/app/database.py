import os
from collections.abc import Iterator
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import URL, create_engine
from sqlalchemy.orm import DeclarativeBase, Session

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")

database_url = URL.create(
    drivername="postgresql+psycopg",
    username=os.getenv("CALORIE_DB_USER", "calorie_app"),
    password=os.environ["CALORIE_DB_PASSWORD"],
    host=os.getenv("CALORIE_DB_HOST", "127.0.0.1"),
    port=int(os.getenv("CALORIE_DB_PORT", "5433")),
    database=os.getenv("CALORIE_DB_NAME", "calorie_tracker"),
)

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
