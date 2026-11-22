import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import auth, config, main, rate_limit
from app.database import get_db
from app.models import AuthSession, User


@pytest.fixture
def details() -> dict[str, str]:
    return {"username": f"User{uuid4().hex[:16]}", "password": secrets.token_urlsafe(24)}


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


def test_register_hashes_password_and_restores_session(
    client: TestClient, details: dict[str, str], db_session: Session,
) -> None:
    response = client.post("/api/auth/register", json=details)
    assert response.status_code == 201
    assert response.json()["username"] == details["username"]
    assert set(response.json()) == {"id", "username", "created_at"}
    assert response.headers["Cache-Control"] == "no-store"
    user = db_session.get(User, response.json()["id"])
    assert user is not None
    assert user.password_hash != details["password"]
    assert user.password_hash.startswith("$argon2id$")
    assert auth.password_hasher.verify(details["password"], user.password_hash)
    token = client.cookies.get(config.SESSION_COOKIE_NAME)
    assert token is not None
    stored = db_session.get(AuthSession, auth.hash_token(token))
    assert stored is not None
    assert stored.token_hash != token
    assert stored.expires_at > datetime.now(UTC)
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert "max-age=604800" in cookie
    assert client.get("/api/auth/me").json() == response.json()


def test_duplicate_username_is_rejected(client: TestClient, details: dict[str, str]) -> None:
    assert client.post("/api/auth/register", json=details).status_code == 201
    response = client.post("/api/auth/register", json=details)
    assert response.status_code == 409
    assert response.json() == {"detail": "That username is already taken."}


@pytest.mark.parametrize("length,expected_status", [(7, 422), (8, 201)])
def test_registration_password_length_boundary(
    client: TestClient, details: dict[str, str], length: int, expected_status: int,
) -> None:
    response = client.post(
        "/api/auth/register",
        json={**details, "password": secrets.token_hex(4)[:length]},
    )
    assert response.status_code == expected_status


@pytest.mark.parametrize("field,value", [
    ("username", "ab"), ("username", "not valid"), ("username", "a" * 65),
    ("password", "short"), ("password", "a" * 129), ("password", None),
])
def test_invalid_registration_never_echoes_passwords(
    client: TestClient, details: dict[str, str], field: str, value: str | None,
) -> None:
    submitted = {**details, field: value}
    response = client.post("/api/auth/register", json=submitted)
    assert response.status_code == 422
    assert details["password"] not in response.text
    assert all("input" not in error for error in response.json()["detail"])


def test_login_accepts_correct_credentials(client: TestClient, details: dict[str, str]) -> None:
    client.post("/api/auth/register", json=details)
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    response = client.post("/api/auth/login", json=details)
    assert response.status_code == 200
    assert response.json()["username"] == details["username"]
    assert client.get("/api/auth/me").status_code == 200


@pytest.mark.parametrize("known_user", [False, True])
def test_wrong_credentials_have_the_same_response(
    client: TestClient, details: dict[str, str], known_user: bool,
) -> None:
    if known_user:
        client.post("/api/auth/register", json=details)
    response = client.post(
        "/api/auth/login", json={**details, "password": secrets.token_urlsafe(24)},
    )
    assert response.status_code == 401
    assert response.json() == {"detail": "Incorrect username or password."}


def test_login_is_case_sensitive(client: TestClient, details: dict[str, str]) -> None:
    client.post("/api/auth/register", json=details)
    response = client.post(
        "/api/auth/login", json={**details, "username": details["username"].lower()},
    )
    assert response.status_code == 401


def test_logout_revokes_a_copied_cookie(client: TestClient, details: dict[str, str]) -> None:
    client.post("/api/auth/register", json=details)
    token = client.cookies.get(config.SESSION_COOKIE_NAME)
    response = client.post("/api/auth/logout")
    assert response.status_code == 204
    assert response.content == b""
    assert client.get("/api/auth/me").status_code == 401
    assert client.get(
        "/api/auth/me", headers={"Cookie": f"{config.SESSION_COOKIE_NAME}={token}"},
    ).status_code == 401
    assert client.post("/api/auth/logout").status_code == 204


def test_expired_session_is_rejected(
    client: TestClient, details: dict[str, str], db_session: Session,
) -> None:
    client.post("/api/auth/register", json=details)
    token = client.cookies.get(config.SESSION_COOKIE_NAME)
    assert token is not None
    session = db_session.get(AuthSession, auth.hash_token(token))
    assert session is not None
    session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.commit()
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login", json=details).status_code == 200
    assert db_session.get(AuthSession, auth.hash_token(token)) is None


def test_login_rotates_the_existing_cookie(
    client: TestClient, details: dict[str, str], db_session: Session,
) -> None:
    client.post("/api/auth/register", json=details)
    previous = client.cookies.get(config.SESSION_COOKIE_NAME)
    assert client.post("/api/auth/login", json=details).status_code == 200
    assert client.cookies.get(config.SESSION_COOKIE_NAME) != previous
    assert previous is not None
    assert db_session.get(AuthSession, auth.hash_token(previous)) is None


def test_tampered_cookie_is_rejected(client: TestClient) -> None:
    response = client.get(
        "/api/auth/me", headers={"Cookie": f"{config.SESSION_COOKIE_NAME}=invalid"},
    )
    assert response.status_code == 401


@pytest.mark.parametrize("path", ["register", "login", "logout"])
def test_cross_origin_requests_are_rejected(
    client: TestClient, details: dict[str, str], path: str,
) -> None:
    response = client.post(
        f"/api/auth/{path}", json=details, headers={"Origin": "https://other.example"},
    )
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_requests_require_csrf_header(client: TestClient, details: dict[str, str]) -> None:
    client.headers.pop("X-CSRF-Protection")
    response = client.post("/api/auth/register", json=details)
    assert response.status_code == 403


def test_authentication_is_throttled(
    client: TestClient, details: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(rate_limit, "auth_limiter", rate_limit.AuthRateLimiter(limit=2))
    assert client.post("/api/auth/login", json=details).status_code == 401
    assert client.post("/api/auth/login", json=details).status_code == 401
    response = client.post("/api/auth/login", json=details)
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"


def test_https_mode_marks_cookies_secure(
    client: TestClient, details: dict[str, str], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(config, "SESSION_COOKIE_SECURE", True)
    response = client.post("/api/auth/register", json=details)
    assert response.status_code == 201
    assert "; secure" in response.headers["set-cookie"].lower()


def test_limiter_recovers_after_its_window(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [100.0]
    monkeypatch.setattr(rate_limit, "monotonic", lambda: clock[0])
    limiter = rate_limit.AuthRateLimiter(limit=1, window_seconds=60)
    limiter.check("test-client")
    with pytest.raises(HTTPException) as caught:
        limiter.check("test-client")
    assert caught.value.status_code == 429
    clock[0] += 60
    limiter.check("test-client")
