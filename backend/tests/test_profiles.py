import json
import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import profiles
from app.models import UserProfile


def credentials() -> dict[str, str]:
    return {"username": f"Profile{uuid4().hex[:16]}", "password": secrets.token_urlsafe(24)}


@pytest.fixture
def profile_client(client: TestClient) -> TestClient:
    assert client.post("/api/auth/register", json=credentials()).status_code == 201
    return client


@pytest.fixture
def payload() -> dict[str, object]:
    return {
        "goal": "maintain",
        "age": 30,
        "height_cm": 175.5,
        "current_weight_kg": 75,
        "gender": "female",
        "activity_description": "Gym twice a week and regular walks.",
        "gym_sessions_per_week": 2,
        "steps_per_day": 6000,
    }


def goal_payload(payload: dict[str, object], goal: str, target: float) -> dict[str, object]:
    return {
        **payload,
        "goal": goal,
        "target_weight_kg": target,
        "target_date": (datetime.now(UTC).date() + timedelta(days=90)).isoformat(),
    }


@pytest.mark.parametrize("method", ["GET", "PUT"])
def test_profiles_require_authentication(
    client: TestClient, payload: dict[str, object], method: str,
) -> None:
    response = client.request(method, "/api/profile", json=payload if method == "PUT" else None)
    assert response.status_code == 401
    assert response.headers["Cache-Control"] == "no-store"


def test_new_account_has_no_profile(profile_client: TestClient) -> None:
    response = profile_client.get("/api/profile")
    assert response.status_code == 404
    assert response.json() == {"detail": "Your profile has not been set up yet."}
    assert response.headers["Cache-Control"] == "no-store"


def test_create_and_read_profile(profile_client: TestClient, payload: dict[str, object]) -> None:
    response = profile_client.put("/api/profile", json=payload)
    assert response.status_code == 201
    assert response.headers["Cache-Control"] == "no-store"
    body = response.json()
    assert body.items() >= payload.items()
    assert body["target_weight_kg"] is None and body["target_date"] is None
    assert set(body) == set(payload) | {"target_weight_kg", "target_date", "created_at", "updated_at"}
    assert profile_client.get("/api/profile").json() == body


def test_updates_replace_the_same_profile(
    profile_client: TestClient, payload: dict[str, object], db_session: Session,
) -> None:
    initial = profile_client.put("/api/profile", json=payload).json()
    changed = {
        **payload,
        "age": 31,
        "height_cm": 176,
        "current_weight_kg": 74.5,
        "activity_description": "  More walks and three gym sessions.  ",
        "gym_sessions_per_week": 3,
        "steps_per_day": 8000,
    }
    response = profile_client.put("/api/profile", json=changed)
    assert response.status_code == 200
    body = response.json()
    assert body["activity_description"] == "More walks and three gym sessions."
    assert body["current_weight_kg"] == 74.5
    assert body["age"] == 31 and body["height_cm"] == 176
    assert body["gym_sessions_per_week"] == 3 and body["steps_per_day"] == 8000
    assert body["created_at"] == initial["created_at"]
    assert body["updated_at"] >= initial["updated_at"]
    assert profile_client.get("/api/profile").json() == body
    owner_id = profile_client.get("/api/auth/me").json()["id"]
    assert db_session.scalar(
        select(func.count()).select_from(UserProfile).where(UserProfile.user_id == owner_id)
    ) == 1


@pytest.mark.parametrize("goal,target", [("gain", 80), ("lose", 70)])
def test_gain_and_lose_goals_round_trip(
    profile_client: TestClient, payload: dict[str, object], goal: str, target: float,
) -> None:
    data = goal_payload(payload, goal, target)
    response = profile_client.put("/api/profile", json=data)
    assert response.status_code == 201
    assert response.json().items() >= data.items()
    assert profile_client.get("/api/profile").json() == response.json()


def test_switching_to_maintain_clears_previous_targets(
    profile_client: TestClient, payload: dict[str, object],
) -> None:
    profile_client.put("/api/profile", json=goal_payload(payload, "gain", 80))
    response = profile_client.put("/api/profile", json=payload)
    assert response.status_code == 200
    assert response.json()["goal"] == "maintain"
    assert response.json()["target_weight_kg"] is None
    assert response.json()["target_date"] is None


@pytest.mark.parametrize("goal,target", [("gain", 75), ("gain", 70), ("lose", 75), ("lose", 80)])
def test_target_weight_must_match_goal_direction(
    profile_client: TestClient, payload: dict[str, object], goal: str, target: float,
) -> None:
    response = profile_client.put("/api/profile", json=goal_payload(payload, goal, target))
    assert response.status_code == 422
    assert profile_client.get("/api/profile").status_code == 404


@pytest.mark.parametrize("missing", ["target_weight_kg", "target_date"])
def test_weight_change_goals_require_both_target_fields(
    profile_client: TestClient, payload: dict[str, object], missing: str,
) -> None:
    data = goal_payload(payload, "gain", 80)
    data.pop(missing)
    assert profile_client.put("/api/profile", json=data).status_code == 422


@pytest.mark.parametrize("target", [{"target_weight_kg": 80}, {"target_date": "2099-01-01"}])
def test_maintain_rejects_weight_change_targets(
    profile_client: TestClient, payload: dict[str, object], target: dict[str, object],
) -> None:
    response = profile_client.put("/api/profile", json={**payload, **target})
    assert response.status_code == 422


@pytest.mark.parametrize("offset", [-1, 0])
def test_deadline_must_be_in_the_future(
    profile_client: TestClient, payload: dict[str, object], offset: int,
) -> None:
    data = goal_payload(payload, "lose", 70)
    data["target_date"] = (datetime.now(UTC).date() + timedelta(days=offset)).isoformat()
    assert profile_client.put("/api/profile", json=data).status_code == 422


def test_stored_profile_remains_readable_after_its_deadline(
    profile_client: TestClient, payload: dict[str, object], monkeypatch: pytest.MonkeyPatch,
) -> None:
    data = goal_payload(payload, "lose", 70)
    saved = profile_client.put("/api/profile", json=data).json()
    later = datetime.now(UTC).date() + timedelta(days=365)
    monkeypatch.setattr(profiles, "today_utc", lambda: later)
    response = profile_client.get("/api/profile")
    assert response.status_code == 200
    assert response.json() == saved
    assert profile_client.put("/api/profile", json=data).status_code == 422


@pytest.mark.parametrize("field,value", [
    ("goal", "unknown"), ("age", 17), ("age", 121), ("age", True),
    ("height_cm", 0), ("height_cm", 301), ("current_weight_kg", 0),
    ("gender", "unknown"), ("activity_description", "   "),
    ("activity_description", "a" * 2001), ("gym_sessions_per_week", -1),
    ("gym_sessions_per_week", 2.5), ("steps_per_day", -1), ("steps_per_day", True),
])
def test_invalid_profile_values_do_not_overwrite_saved_data(
    profile_client: TestClient, payload: dict[str, object], field: str, value: object,
) -> None:
    original = profile_client.put("/api/profile", json=payload).json()
    response = profile_client.put("/api/profile", json={**payload, field: value})
    assert response.status_code == 422
    assert all("input" not in error for error in response.json()["detail"])
    assert profile_client.get("/api/profile").json() == original


def test_non_finite_measurements_are_rejected(
    profile_client: TestClient, payload: dict[str, object],
) -> None:
    response = profile_client.put(
        "/api/profile",
        content=json.dumps({**payload, "current_weight_kg": float("nan")}),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422


@pytest.mark.parametrize("gender", ["female", "male", "other", "prefer_not_to_say"])
def test_supported_gender_values(
    profile_client: TestClient, payload: dict[str, object], gender: str,
) -> None:
    response = profile_client.put("/api/profile", json={**payload, "gender": gender})
    assert response.status_code == 201
    assert response.json()["gender"] == gender


def test_put_requires_a_complete_profile(
    profile_client: TestClient, payload: dict[str, object],
) -> None:
    original = profile_client.put("/api/profile", json=payload).json()
    assert profile_client.put("/api/profile", json={"age": 31}).status_code == 422
    assert profile_client.get("/api/profile").json() == original


@pytest.mark.parametrize("headers", [
    {"X-CSRF-Protection": "0"}, {"Origin": "https://other.example"},
])
def test_profile_writes_require_trusted_request_headers(
    profile_client: TestClient, payload: dict[str, object], headers: dict[str, str],
) -> None:
    response = profile_client.put("/api/profile", json=payload, headers=headers)
    assert response.status_code == 403
    assert profile_client.get("/api/profile").status_code == 404


def test_profiles_are_isolated_between_accounts(client: TestClient, payload: dict[str, object]) -> None:
    first = credentials()
    first_id = client.post("/api/auth/register", json=first).json()["id"]
    first_profile = client.put("/api/profile", json=payload).json()
    client.post("/api/auth/logout")
    client.post("/api/auth/register", json=credentials())
    assert client.get("/api/profile").status_code == 404
    second_profile = client.put("/api/profile", json={**payload, "age": 40}).json()
    assert client.get("/api/profile", params={"user_id": first_id}).json() == second_profile
    assert client.get(f"/api/profile/{first_id}").status_code == 404
    assert client.put("/api/profile", json={**payload, "user_id": first_id}).status_code == 422
    assert client.get("/api/profile").json() == second_profile
    client.post("/api/auth/logout")
    client.post("/api/auth/login", json=first)
    assert client.get("/api/profile").json() == first_profile


def test_database_enforces_goal_consistency(
    profile_client: TestClient, payload: dict[str, object], db_session: Session,
) -> None:
    owner_id = profile_client.get("/api/auth/me").json()["id"]
    invalid = {**payload, "goal": "gain", "target_date": datetime.now(UTC).date() + timedelta(days=90)}
    with pytest.raises(IntegrityError):
        with db_session.begin_nested():
            db_session.add(UserProfile(user_id=owner_id, **invalid))
            db_session.flush()
