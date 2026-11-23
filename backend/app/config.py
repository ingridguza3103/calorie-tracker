import os
from pathlib import Path

from dotenv import load_dotenv
from app.database_settings import load_database_url

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")

database_url = load_database_url(os.environ)

ALLOWED_ORIGINS = frozenset(
    origin.strip().rstrip("/")
    for origin in os.getenv(
        "CALORIE_ALLOWED_ORIGINS",
        "http://127.0.0.1:5174,http://localhost:5174,"
        "http://127.0.0.1:8001,http://localhost:8001",
    ).split(",")
    if origin.strip()
)
SESSION_COOKIE_NAME = "calorie_session"
SESSION_COOKIE_SECURE = os.getenv("CALORIE_COOKIE_SECURE", "false").lower() == "true"
SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60
