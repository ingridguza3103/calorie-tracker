from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from app import main


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(main.app) as api_client:
        yield api_client


@pytest.fixture
def unavailable_database(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_connect() -> None:
        raise SQLAlchemyError("Internal database connection details")

    monkeypatch.setattr(main.engine, "connect", fail_connect)


def test_readiness_connects_to_database(client: TestClient) -> None:
    response = client.get("/api/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "database": "connected",
    }


@pytest.mark.usefixtures("unavailable_database")
def test_readiness_hides_database_errors(client: TestClient) -> None:
    response = client.get("/api/ready")

    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}


@pytest.mark.usefixtures("unavailable_database")
def test_health_remains_available_without_database(
    client: TestClient,
) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200