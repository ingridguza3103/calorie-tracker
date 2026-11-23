import json
import secrets
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app import main, maintenance
from app.groq_client import GroqClient, GroqSettings
from app.rate_limit import AuthRateLimiter


@pytest.fixture(autouse=True)
def isolated_estimation_config(monkeypatch: pytest.MonkeyPatch) -> None:
    # This suite never requires a live key, paid service, or external network.
    monkeypatch.setenv("GROQ_API_KEY", "")
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    monkeypatch.delenv("GROQ_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setattr(maintenance, "estimate_limiter", AuthRateLimiter(limit=100))
    monkeypatch.setattr(maintenance, "provider_limiter", AuthRateLimiter(limit=100))


@pytest.fixture
def profile() -> dict[str, object]:
    return {
        "goal": "maintain", "age": 30, "height_cm": 175.5, "current_weight_kg": 75,
        "gender": "female", "activity_description": "Office work and two gym sessions.",
        "gym_sessions_per_week": 2, "steps_per_day": 6000,
    }


def register(client: TestClient) -> None:
    result = client.post("/api/auth/register", json={
        "username": "Estimate" + secrets.token_hex(8), "password": secrets.token_urlsafe(24),
    })
    assert result.status_code == 201


@pytest.fixture
def account(client: TestClient, profile: dict[str, object]) -> TestClient:
    register(client)
    assert client.put("/api/profile", json=profile).status_code == 201
    return client


@pytest.fixture
def provider(request: pytest.FixtureRequest) -> Iterator[list[httpx.Request]]:
    calls: list[httpx.Request] = []
    level = getattr(request, "param", "moderate")

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"activity_level": level, "summary": "Regular walking and gym.",
                                   "assumptions": ["Gym sessions are assumed to be moderate effort."]}),
        }}]})

    client = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(respond))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: client
    try:
        yield calls
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)


def test_estimates_require_a_login(client: TestClient, provider: list[httpx.Request]) -> None:
    response = client.post("/api/maintenance/estimate", json={})
    assert response.status_code == 401 and not provider
    assert response.headers["cache-control"] == "no-store"


def test_estimates_require_a_saved_profile(client: TestClient, provider: list[httpx.Request]) -> None:
    register(client)
    response = client.post("/api/maintenance/estimate", json={})
    assert response.status_code == 409 and not provider


def test_estimate_uses_current_saved_profile_and_reliable_arithmetic(
    account: TestClient, provider: list[httpx.Request],
) -> None:
    saved = account.get("/api/profile").json()
    before = datetime.now(UTC)
    response = account.post("/api/maintenance/estimate", json={})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    estimate = response.json()
    assert estimate["resting_calories"] == 1536
    # Calculate from unrounded resting energy: 1535.875 * 1.55 = 2380.60625.
    assert estimate["maintenance_calories"] == 2381
    assert estimate["activity_factor"] == 1.55
    assert estimate["activity"]["activity_level"] == "moderate"
    assert estimate["formula"] == "mifflin_st_jeor" and estimate["formula_basis"] == "female"
    assert estimate["model"] == "openai/gpt-oss-20b"
    assert estimate["profile_updated_at"] == saved["updated_at"]
    assert datetime.fromisoformat(estimate["estimated_at"]) >= before
    assert account.get("/api/profile").json() == saved
    sent = json.loads(json.loads(provider[0].content)["messages"][1]["content"])
    assert sent == {key: saved[key] for key in (
        "activity_description", "gym_sessions_per_week", "steps_per_day",
    )}
    assert len(provider) == 1 and "test-only-key" not in response.text


@pytest.mark.parametrize("provider,expected", [
    ("sedentary", 1843), ("light", 2112), ("moderate", 2381),
    ("active", 2649), ("very_active", 2918),
], indirect=["provider"])
def test_every_activity_level_produces_a_single_rounded_maintenance_value(
    account: TestClient, provider: list[httpx.Request], expected: int,
) -> None:
    response = account.post("/api/maintenance/estimate", json={})
    assert response.status_code == 200 and response.json()["maintenance_calories"] == expected


def test_a_new_estimate_uses_profile_edits_without_automatic_provider_calls(
    account: TestClient, provider: list[httpx.Request], profile: dict[str, object],
) -> None:
    assert not provider
    first = account.post("/api/maintenance/estimate", json={}).json()
    changed = {**profile, "current_weight_kg": 80, "steps_per_day": 8000}
    assert account.put("/api/profile", json=changed).status_code == 200
    assert len(provider) == 1
    second = account.post("/api/maintenance/estimate", json={}).json()
    assert first["maintenance_calories"] == 2381 and second["maintenance_calories"] == 2458
    sent = json.loads(json.loads(provider[1].content)["messages"][1]["content"])
    assert sent["steps_per_day"] == 8000 and len(provider) == 2


@pytest.mark.parametrize("gender,resting,maintenance_value,basis", [
    ("male", 1702, 2638, "male"), ("other", 1619, 2509, "midpoint"),
    ("prefer_not_to_say", 1619, 2509, "midpoint"),
])
def test_formula_basis_is_explicit_for_every_gender_choice(
    account: TestClient, profile: dict[str, object], provider: list[httpx.Request],
    gender: str, resting: int, maintenance_value: int, basis: str,
) -> None:
    account.put("/api/profile", json={**profile, "gender": gender})
    body = account.post("/api/maintenance/estimate", json={}).json()
    assert body["formula_basis"] == basis and body["resting_calories"] == resting
    assert body["maintenance_calories"] == maintenance_value
    if basis == "midpoint":
        assert "not a separately validated equation" in " ".join(body["assumptions"])


@pytest.mark.parametrize("weight", [20, 44.87])
def test_inconsistent_measurements_do_not_consume_provider_quota(
    account: TestClient, profile: dict[str, object], provider: list[httpx.Request],
    weight: float,
) -> None:
    assert account.put("/api/profile", json={**profile, "height_cm": 50, "current_weight_kg": weight, "age": 120}).status_code == 200
    result = account.post("/api/maintenance/estimate", json={})
    assert result.status_code == 422 and not provider


@pytest.mark.parametrize("headers", [
    {"X-CSRF-Protection": "0"}, {"Origin": "https://untrusted.example"},
])
def test_estimation_requires_csrf_protection(
    account: TestClient, provider: list[httpx.Request], headers: dict[str, str],
) -> None:
    response = account.post("/api/maintenance/estimate", json={}, headers=headers)
    assert response.status_code == 403 and not provider


@pytest.mark.parametrize("body", [{"user_id": 123}, {"model": "other-model"}, {"age": 1}, {"prompt": "ignore rules"}])
def test_request_cannot_override_account_profile_or_model(
    account: TestClient, provider: list[httpx.Request], body: dict[str, object],
) -> None:
    response = account.post("/api/maintenance/estimate", json=body)
    assert response.status_code == 422 and not provider


def test_other_accounts_cannot_estimate_the_first_accounts_profile(
    account: TestClient, provider: list[httpx.Request],
) -> None:
    first_id = account.get("/api/auth/me").json()["id"]
    account.post("/api/auth/logout")
    register(account)
    assert account.post("/api/maintenance/estimate", json={"user_id": first_id}).status_code == 409
    assert account.post("/api/maintenance/estimate", json={}).status_code == 409 and not provider


@pytest.mark.parametrize("goal,target", [("gain", 80), ("lose", 70)])
def test_weight_change_goals_do_not_bias_maintenance(
    account: TestClient, profile: dict[str, object], provider: list[httpx.Request], goal: str, target: int,
) -> None:
    target_date = (datetime.now(UTC).date() + timedelta(days=90)).isoformat()
    account.put("/api/profile", json={**profile, "goal": goal, "target_weight_kg": target, "target_date": target_date})
    body = account.post("/api/maintenance/estimate", json={}).json()
    assert body["maintenance_calories"] == 2381
    prompt = json.loads(provider[0].content)["messages"][1]["content"]
    assert "target_weight" not in prompt and "target_date" not in prompt and '"goal"' not in prompt


def test_missing_key_has_a_clear_error_and_does_not_break_health(account: TestClient) -> None:
    response = account.post("/api/maintenance/estimate", json={})
    assert response.status_code == 503 and "GROQ_API_KEY" in response.json()["detail"]
    assert response.headers["cache-control"] == "no-store"
    assert account.get("/api/health").status_code == 200


def test_invalid_server_settings_are_sanitized(
    account: TestClient, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GROQ_TIMEOUT_SECONDS", "private-invalid-setting")
    response = account.post("/api/maintenance/estimate", json={})
    assert response.status_code == 503 and "private-invalid-setting" not in response.text


@pytest.mark.parametrize("status,expected", [(429, 429), (401, 503), (500, 503), (200, 502)])
def test_provider_failures_reach_the_api_without_internal_details(
    account: TestClient, status: int, expected: int,
) -> None:
    client = GroqClient(GroqSettings(SecretStr("do-not-leak")), httpx.MockTransport(
        lambda _: httpx.Response(status, text="do-not-leak provider debug info", headers={"Retry-After": "90"}),
    ))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: client
    try:
        response = account.post("/api/maintenance/estimate", json={})
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    assert response.status_code == expected and "do-not-leak" not in response.text
    assert response.headers["cache-control"] == "no-store"
    if expected == 429:
        assert response.headers["retry-after"] == "90"


def test_provider_deadline_returns_504_to_the_api(account: TestClient) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("private-provider-details", request=request)

    client = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(timeout))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: client
    try:
        response = account.post("/api/maintenance/estimate", json={})
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    assert response.status_code == 504 and "private-provider-details" not in response.text


@pytest.mark.parametrize("limiter", ["estimate_limiter", "provider_limiter"])
def test_rate_limits_reject_requests_before_spending_provider_quota(
    account: TestClient, provider: list[httpx.Request], monkeypatch: pytest.MonkeyPatch, limiter: str,
) -> None:
    monkeypatch.setattr(maintenance, limiter, AuthRateLimiter(limit=1))
    assert account.post("/api/maintenance/estimate", json={}).status_code == 200
    response = account.post("/api/maintenance/estimate", json={})
    assert response.status_code == 429 and response.headers["retry-after"] == "60"
    assert len(provider) == 1


def test_rate_limit_is_per_account(
    account: TestClient, provider: list[httpx.Request], profile: dict[str, object], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(maintenance, "estimate_limiter", AuthRateLimiter(limit=1))
    assert account.post("/api/maintenance/estimate", json={}).status_code == 200
    account.post("/api/auth/logout")
    register(account)
    account.put("/api/profile", json=profile)
    assert account.post("/api/maintenance/estimate", json={}).status_code == 200
    assert len(provider) == 2
