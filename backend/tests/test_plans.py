import json
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import main, maintenance, plans
from app.groq_client import GroqClient, GroqSettings
from app.models import NutritionPlan, User, UserProfile
from app.rate_limit import AuthRateLimiter


@pytest.fixture(autouse=True)
def reset_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "")
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    monkeypatch.delenv("GROQ_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setattr(maintenance, "estimate_limiter", AuthRateLimiter(limit=100))
    monkeypatch.setattr(maintenance, "provider_limiter", AuthRateLimiter(limit=100))


@pytest.fixture
def payload() -> dict[str, object]:
    return {
        "goal": "maintain", "age": 30, "height_cm": 175.5, "current_weight_kg": 75,
        "gender": "female", "activity_description": "Office work and regular walking.",
        "gym_sessions_per_week": 2, "steps_per_day": 6000,
    }


def register(client: TestClient) -> int:
    response = client.post("/api/auth/register", json={
        "username": "Plan" + secrets.token_hex(8), "password": secrets.token_urlsafe(24),
    })
    assert response.status_code == 201
    return response.json()["id"]


@pytest.fixture
def account(client: TestClient, payload: dict[str, object]) -> TestClient:
    register(client)
    assert client.put("/api/profile", json=payload).status_code == 201
    return client


@pytest.fixture
def provider() -> Iterator[list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"activity_level": "moderate", "summary": "Walking and regular gym.", "assumptions": []}),
        }}]})

    provider = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(respond))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: provider
    try:
        yield calls
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_plan_requires_login(client: TestClient, method: str, provider: list[httpx.Request]) -> None:
    response = client.request(method, "/api/plan", json={} if method == "POST" else None)
    assert response.status_code == 401 and response.headers["cache-control"] == "no-store"
    assert not provider


def test_profile_is_required(client: TestClient, provider: list[httpx.Request]) -> None:
    register(client)
    assert client.get("/api/plan").status_code == 409
    assert client.post("/api/plan", json={}).status_code == 409 and not provider


def test_creating_then_reloading_or_reposting_reuses_one_saved_plan(
    account: TestClient, provider: list[httpx.Request], db_session: Session,
) -> None:
    assert account.get("/api/plan").status_code == 404 and not provider
    created = account.post("/api/plan", json={})
    assert created.status_code == 201
    plan = created.json()
    assert plan["targets"]["daily_calories"] == plan["maintenance"]["maintenance_calories"] == 2381
    assert plan["targets"]["calorie_adjustment"] == 0
    assert plan["target_date"] is None and plan["timeline_days"] is None
    assert account.get("/api/plan").json() == plan
    again = account.post("/api/plan", json={})
    assert again.status_code == 200 and again.json() == plan and len(provider) == 1
    owner_id = account.get("/api/auth/me").json()["id"]
    assert db_session.scalar(select(func.count()).select_from(NutritionPlan).where(NutritionPlan.user_id == owner_id)) == 1
    assert created.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("goal,target", [("lose", 70), ("gain", 80)])
def test_weight_change_goals_have_daily_adjustments_and_future_target_dates(
    account: TestClient, payload: dict[str, object], provider: list[httpx.Request], goal: str, target: int,
) -> None:
    deadline = (datetime.now(UTC).date() + timedelta(days=150)).isoformat()
    account.put("/api/profile", json={**payload, "goal": goal, "target_weight_kg": target, "target_date": deadline})
    response = account.post("/api/plan", json={})
    assert response.status_code == 201
    plan = response.json()
    assert plan["goal"] == goal and plan["target_date"] == deadline
    assert (plan["targets"]["calorie_adjustment"] < 0) == (goal == "lose")


def test_extreme_goal_is_blocked_before_calling_groq_or_saving(
    account: TestClient, payload: dict[str, object], provider: list[httpx.Request],
) -> None:
    account.put("/api/profile", json={**payload, "goal": "lose", "target_weight_kg": 60,
        "target_date": (datetime.now(UTC).date() + timedelta(days=7)).isoformat()})
    response = account.post("/api/plan", json={})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "timeline_too_short"
    assert not provider and account.get("/api/plan").status_code == 404


def test_excessive_calorie_adjustment_is_not_persisted(
    account: TestClient, payload: dict[str, object], provider: list[httpx.Request],
) -> None:
    account.put("/api/profile", json={**payload, "goal": "lose", "current_weight_kg": 45, "height_cm": 140, "target_weight_kg": 40,
        "target_date": (datetime.now(UTC).date() + timedelta(days=60)).isoformat()})
    response = account.post("/api/plan", json={})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "calorie_adjustment_too_large"
    assert len(provider) == 1 and account.get("/api/plan").status_code == 404


def test_profile_edits_invalidate_plan_but_identical_saves_do_not(
    account: TestClient, payload: dict[str, object], provider: list[httpx.Request],
) -> None:
    first = account.post("/api/plan", json={}).json()
    account.put("/api/profile", json=payload)
    assert account.get("/api/plan").json() == first
    account.put("/api/profile", json={**payload, "current_weight_kg": 80})
    assert account.get("/api/plan").status_code == 404
    changed = account.post("/api/plan", json={})
    assert changed.status_code == 201 and changed.json()["targets"]["daily_calories"] != first["targets"]["daily_calories"]
    assert len(provider) == 2


def test_plan_is_private_to_the_current_account(
    account: TestClient, payload: dict[str, object], provider: list[httpx.Request],
) -> None:
    first = account.post("/api/plan", json={}).json()
    account.post("/api/auth/logout")
    register(account)
    account.put("/api/profile", json={**payload, "age": 40})
    assert account.get("/api/plan").status_code == 404
    second = account.post("/api/plan", json={}).json()
    assert second["targets"]["daily_calories"] != first["targets"]["daily_calories"]


@pytest.mark.parametrize("headers", [{"X-CSRF-Protection": "0"}, {"Origin": "https://untrusted.example"}])
def test_plan_creation_requires_csrf(
    account: TestClient, provider: list[httpx.Request], headers: dict[str, str],
) -> None:
    assert account.post("/api/plan", json={}, headers=headers).status_code == 403
    assert not provider


def test_request_cannot_override_user_or_supply_client_calories(account: TestClient, provider: list[httpx.Request]) -> None:
    assert account.post("/api/plan", json={"user_id": 1, "daily_calories": 100}).status_code == 422
    assert not provider


def test_elapsed_plan_requires_a_new_date(
    account: TestClient, payload: dict[str, object], provider: list[httpx.Request], monkeypatch: pytest.MonkeyPatch,
) -> None:
    today = datetime.now(UTC).date()
    account.put("/api/profile", json={**payload, "goal": "lose", "target_weight_kg": 70,
        "target_date": (today + timedelta(days=150)).isoformat()})
    assert account.post("/api/plan", json={}).status_code == 201
    monkeypatch.setattr(plans, "today_utc", lambda: today + timedelta(days=151))
    assert account.get("/api/plan").status_code == 404
    assert account.post("/api/plan", json={}).json()["detail"]["code"] == "goal_date"
    assert len(provider) == 1


def test_profile_change_during_generation_does_not_save_stale_plan(
    account: TestClient, provider: list[httpx.Request],
    db_session: Session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = plans.estimate_for_profile

    async def change_while_waiting(profile, user_id, groq):
        estimate = await original(profile, user_id, groq)
        current = db_session.get(UserProfile, user_id)
        current.age += 1
        db_session.commit()
        return estimate

    monkeypatch.setattr(plans, "estimate_for_profile", change_while_waiting)
    response = account.post("/api/plan", json={})
    assert response.status_code == 409 and account.get("/api/plan").status_code == 404


def test_account_deletion_cascades_to_its_plan(account: TestClient, provider: list[httpx.Request], db_session: Session) -> None:
    assert account.post("/api/plan", json={}).status_code == 201
    owner_id = account.get("/api/auth/me").json()["id"]
    db_session.execute(delete(User).where(User.id == owner_id))
    db_session.flush()
    assert db_session.get(NutritionPlan, owner_id) is None


def test_late_second_save_reuses_an_already_created_plan(
    account: TestClient, provider: list[httpx.Request], db_session: Session,
) -> None:
    owner_id = account.get("/api/auth/me").json()["id"]
    context = plans.plan_context(db_session.get(User, owner_id), db_session)
    assert context.cached is None
    saved = account.post("/api/plan", json={}).json()
    candidate = plans.CaloriePlan.model_validate(saved)
    assert plans.store_plan(db_session, context, candidate).model_dump(mode="json") == saved
    assert len(provider) == 1


@pytest.mark.parametrize("status,expected", [(429, 429), (401, 503), (500, 503), (200, 502)])
def test_groq_failures_do_not_persist_a_plan(account: TestClient, status: int, expected: int) -> None:
    provider = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(
        lambda _: httpx.Response(status, text="private-provider-detail", headers={"Retry-After": "90"}),
    ))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: provider
    try:
        response = account.post("/api/plan", json={})
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    assert response.status_code == expected and "private-provider-detail" not in response.text
    assert account.get("/api/plan").status_code == 404
    if status == 429:
        assert response.headers["retry-after"] == "90"


def test_cached_plan_remains_available_without_a_configured_key(
    account: TestClient, provider: list[httpx.Request],
) -> None:
    saved = account.post("/api/plan", json={}).json()
    override = main.app.dependency_overrides.pop(maintenance.get_groq_client)
    try:
        assert account.get("/api/plan").json() == saved
        assert account.post("/api/plan", json={}).json() == saved
    finally:
        main.app.dependency_overrides[maintenance.get_groq_client] = override


@pytest.mark.parametrize("legacy", [False, True])
def test_ambitious_four_week_gain_is_saved_and_reloaded_without_more_ai_calls(
    account: TestClient, payload: dict[str, object], provider: list[httpx.Request], db_session: Session, legacy: bool,
) -> None:
    deadline = (datetime.now(UTC).date() + timedelta(days=28)).isoformat()
    assert account.put("/api/profile", json={**payload, "goal": "gain", "target_weight_kg": 77, "target_date": deadline}).status_code == 200
    created = account.post("/api/plan", json={})
    assert created.status_code == 201
    saved = created.json()
    assert saved["targets"]["calorie_adjustment"] == 550 and saved["warnings"]
    if legacy:
        owner = account.get("/api/auth/me").json()["id"]
        record = db_session.get(NutritionPlan, owner)
        record.payload = {key: value for key, value in record.payload.items() if key != "warnings"}
        db_session.commit()
    assert account.get("/api/plan").json() == saved
    assert account.post("/api/plan", json={}).json() == saved
    assert len(provider) == 1
