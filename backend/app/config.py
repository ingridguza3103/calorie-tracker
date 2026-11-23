import os
from collections.abc import Mapping
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from app.database_settings import LOCAL_HOSTS, load_database_url

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")

database_url = load_database_url(os.environ)

LOCAL_ORIGINS = (
    "http://127.0.0.1:5174,http://localhost:5174,"
    "http://127.0.0.1:8001,http://localhost:8001"
)


def normalize_origin(value: str) -> str:
    try:
        origin = urlsplit(value.strip().rstrip("/"))
        if (
            origin.scheme not in {"http", "https"}
            or not origin.hostname
            or origin.username is not None
            or origin.password is not None
            or origin.path or origin.query or origin.fragment
        ):
            raise ValueError
        if origin.scheme == "http" and origin.hostname not in LOCAL_HOSTS:
            raise ValueError
        host = origin.hostname
        if ":" in host:
            host = f"[{host}]"
        port = origin.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError
        default_port = 80 if origin.scheme == "http" else 443
        if port is not None and port != default_port:
            host = f"{host}:{port}"
        return f"{origin.scheme}://{host}"
    except ValueError:
        raise ValueError("Configure a single HTTPS origin, or HTTP on localhost, without a path.") from None


def load_web_settings(values: Mapping[str, str]) -> tuple[frozenset[str], bool]:
    default = values.get("APP_ORIGIN") or values.get("RENDER_EXTERNAL_URL") or LOCAL_ORIGINS
    origins = frozenset(
        normalize_origin(origin)
        for origin in values.get("CALORIE_ALLOWED_ORIGINS", default).split(",")
        if origin.strip()
    )
    if not origins:
        raise ValueError("Configure at least one allowed browser origin.")
    uses_https = any(origin.startswith("https://") for origin in origins)
    cookie_setting = values.get("CALORIE_COOKIE_SECURE", str(uses_https)).lower()
    if cookie_setting not in {"true", "false"}:
        raise ValueError("CALORIE_COOKIE_SECURE must be true or false.")
    secure = cookie_setting == "true"
    if uses_https and not secure:
        raise ValueError("HTTPS origins require secure cookies; remove CALORIE_COOKIE_SECURE=false.")
    return origins, secure


ALLOWED_ORIGINS, SESSION_COOKIE_SECURE = load_web_settings(os.environ)
SESSION_COOKIE_NAME = "calorie_session"
SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60
