from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from app import main, web


@pytest.fixture
def frontend_dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<html><div id="root"></div><script src="/assets/app.js"></script></html>')
    (tmp_path / "assets" / "app.js").write_text('console.log("app")')
    return tmp_path


def test_production_entry_serves_frontend_assets_and_api(frontend_dist: Path) -> None:
    production_app = web.create_app(frontend_dist)
    assert production_app is not main.app
    with TestClient(production_app) as client:
        index = client.get("/")
        assert index.status_code == 200 and 'id="root"' in index.text
        assert index.headers["content-type"].startswith("text/html")
        assert index.headers["cache-control"] == "no-cache"
        asset = client.get("/assets/app.js")
        assert asset.status_code == 200 and "console.log" in asset.text
        assert client.get("/api/health").json() == {"status": "ok"}
        denied = client.get("/api/auth/me")
        assert denied.status_code == 401 and denied.headers["cache-control"] == "no-store"
        assert client.get("/api/unknown").status_code == 404
        assert client.get("/assets/missing.js").status_code == 404


def test_render_health_probe_does_not_depend_on_database(
    frontend_dist: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unavailable() -> None:
        raise SQLAlchemyError("Database is asleep")
    monkeypatch.setattr(main.engine, "connect", unavailable)
    with TestClient(web.create_app(frontend_dist)) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/ready").status_code == 503


def test_default_frontend_location_uses_the_project_root(
    frontend_dist: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "application"
    target = root / "frontend" / "dist"
    target.mkdir(parents=True)
    (target / "index.html").write_text((frontend_dist / "index.html").read_text())
    monkeypatch.setattr(web, "PROJECT_ROOT", root)
    with TestClient(web.create_app()) as client:
        assert client.get("/").status_code == 200


def test_missing_frontend_build_fails_at_startup(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="does not exist"):
        web.create_app(tmp_path / "missing")
