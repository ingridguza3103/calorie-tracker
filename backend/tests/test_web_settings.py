import secrets

import pytest
from fastapi.testclient import TestClient

from app import config, main


def test_local_development_keeps_existing_origins_and_http_cookies() -> None:
    origins, secure = config.load_web_settings({})
    assert origins == frozenset({
        "http://127.0.0.1:5174", "http://localhost:5174",
        "http://127.0.0.1:8001", "http://localhost:8001",
    })
    assert not secure


def test_render_url_automatically_configures_origin_and_secure_cookies() -> None:
    origins, secure = config.load_web_settings({"RENDER_EXTERNAL_URL": "https://calorie-tracker.onrender.com/"})
    assert origins == frozenset({"https://calorie-tracker.onrender.com"})
    assert secure


def test_custom_domain_takes_precedence_over_render_domain() -> None:
    origins, secure = config.load_web_settings({
        "APP_ORIGIN": "https://tracker.example", "RENDER_EXTERNAL_URL": "https://tracker.onrender.com",
    })
    assert origins == frozenset({"https://tracker.example"}) and secure


def test_explicit_origin_allowlist_remains_supported() -> None:
    origins, secure = config.load_web_settings({
        "APP_ORIGIN": "https://default.example",
        "CALORIE_ALLOWED_ORIGINS": " https://one.example/, https://two.example ",
        "CALORIE_COOKIE_SECURE": "true",
    })
    assert origins == frozenset({"https://one.example", "https://two.example"}) and secure


@pytest.mark.parametrize("origin,expected", [
    ("http://127.0.0.1:10000", "http://127.0.0.1:10000"),
    ("http://localhost:80", "http://localhost"),
    ("http://[::1]:10000", "http://[::1]:10000"),
    ("https://Tracker.Example:443/", "https://tracker.example"),
])
def test_origin_normalization(origin: str, expected: str) -> None:
    assert config.normalize_origin(origin) == expected


@pytest.mark.parametrize("origin", [
    "http://tracker.example", "https://tracker.example/path", "https://user@tracker.example",
    "https://tracker.example?query=yes", "https://tracker.example#fragment", "ftp://tracker.example",
    "https://", "http://localhost:0", "https://tracker.example:invalid", "https://tracker.example:65536",
])
def test_invalid_public_origins_are_rejected(origin: str) -> None:
    with pytest.raises(ValueError, match="single HTTPS origin"):
        config.load_web_settings({"APP_ORIGIN": origin})


def test_empty_allowlist_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least one"):
        config.load_web_settings({"CALORIE_ALLOWED_ORIGINS": " , "})


def test_https_cannot_accidentally_disable_secure_cookies() -> None:
    with pytest.raises(ValueError, match="HTTPS origins require secure cookies"):
        config.load_web_settings({"RENDER_EXTERNAL_URL": "https://tracker.onrender.com", "CALORIE_COOKIE_SECURE": "false"})


def test_invalid_cookie_flag_is_rejected() -> None:
    with pytest.raises(ValueError, match="true or false"):
        config.load_web_settings({"CALORIE_COOKIE_SECURE": "sometimes"})


def test_https_login_cookies_work_and_untrusted_origins_are_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    origin = "https://tracker.onrender.com"
    origins, secure = config.load_web_settings({"RENDER_EXTERNAL_URL": origin})
    monkeypatch.setattr(config, "ALLOWED_ORIGINS", origins)
    monkeypatch.setattr(config, "SESSION_COOKIE_SECURE", secure)
    with TestClient(main.app, base_url=origin, headers={"Origin": origin, "X-CSRF-Protection": "1"}) as browser:
        created = browser.post("/api/auth/register", json={
            "username": "Https" + secrets.token_hex(8), "password": secrets.token_urlsafe(24),
        })
        assert created.status_code == 201
        cookie = created.headers["set-cookie"].lower()
        assert "secure" in cookie and "httponly" in cookie and "samesite=lax" in cookie
        assert browser.get("/api/auth/me").json()["id"] == created.json()["id"]
        assert browser.post("/api/auth/logout", headers={"Origin": "https://other.example"}).status_code == 403
        response = browser.post("/api/auth/logout")
        assert response.status_code == 204 and "secure" in response.headers["set-cookie"].lower()
        assert browser.get("/api/auth/me").status_code == 401
