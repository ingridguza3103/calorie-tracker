import json
import secrets
from dataclasses import replace
from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import foods, main, maintenance
from app.food_nutrition import FOOD_SCHEMA, FoodNutrition
from app.groq_client import GroqClient, GroqSettings
from app.models import FoodEstimate, User
from app.rate_limit import AuthRateLimiter

APPLE = {
    "name": "Medium apple", "serving_description": "One medium raw apple, with skin.",
    "estimated_weight_g": 182.0, "calories": 95,
    "protein_g": 0.5, "carbohydrate_g": 25.1, "fat_g": 0.3, "fiber_g": 4.4,
    "serving_assumptions": ["Assumed: one medium edible apple, about 182g."],
    "cooking_assumptions": ["Assumed: raw, with skin; no added fat."],
}


def completion(food: dict[str, object] | None) -> dict[str, object]:
    content = {"recognized": food is not None, "food": food}
    return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(content)}}]}


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GROQ_API_KEY", "")
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    monkeypatch.delenv("GROQ_TIMEOUT_SECONDS", raising=False)
    monkeypatch.setattr(foods, "food_limiter", AuthRateLimiter(limit=100))
    monkeypatch.setattr(maintenance, "provider_limiter", AuthRateLimiter(limit=100))


def register(client: TestClient) -> int:
    response = client.post("/api/auth/register", json={
        "username": "Food" + secrets.token_hex(8), "password": secrets.token_urlsafe(24),
    })
    assert response.status_code == 201
    return response.json()["id"]


def owned_count(client: TestClient, db: Session) -> int:
    owner = client.get("/api/auth/me").json()["id"]
    return db.scalar(select(func.count()).select_from(FoodEstimate).where(FoodEstimate.user_id == owner))


@pytest.fixture
def account(client: TestClient) -> TestClient:
    register(client)
    return client


@pytest.fixture
def provider() -> Iterator[list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=completion(APPLE))

    groq = GroqClient(GroqSettings(SecretStr("test-only-provider-key")), httpx.MockTransport(respond))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: groq
    try:
        yield calls
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)


def test_food_estimation_requires_login(client: TestClient, provider: list[httpx.Request]) -> None:
    response = client.post("/api/food/estimate", json={"description": "apple"})
    assert response.status_code == 401 and not provider
    assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/food/estimates/1").status_code == 401


def test_food_estimate_records_totals_assumptions_and_description_without_a_profile(
    account: TestClient, provider: list[httpx.Request], db_session: Session,
) -> None:
    response = account.post("/api/food/estimate", json={"description": "  apple  "})
    assert response.status_code == 201 and response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["description"] == "apple" and body["food"] == APPLE
    assert body["model"] == "openai/gpt-oss-20b" and body["estimated_at"]
    saved = db_session.get(FoodEstimate, body["id"])
    assert saved.description == "apple" and saved.payload == APPLE
    restored = account.get("/api/food/estimates/" + str(body["id"]))
    assert restored.status_code == 200 and restored.json() == body
    assert restored.headers["cache-control"] == "no-store"


def test_provider_receives_only_food_text_and_a_strict_food_schema(
    account: TestClient, provider: list[httpx.Request],
) -> None:
    response = account.post("/api/food/estimate", json={"description": "fried egg"})
    assert response.status_code == 201
    request = json.loads(provider[0].content)
    assert request["response_format"]["type"] == "json_schema"
    assert request["response_format"]["json_schema"] == {
        "name": "food_nutrition", "strict": True, "schema": FOOD_SCHEMA,
    }
    assert json.loads(request["messages"][1]["content"]) == {"description": "fried egg"}
    assert "Count the specified added fat once" in request["messages"][0]["content"]
    assert "test-only-provider-key" not in response.text


def test_identical_food_requests_reuse_a_saved_estimate_and_do_not_consume_quota(
    account: TestClient, provider: list[httpx.Request], monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = account.post("/api/food/estimate", json={"description": "apple"})
    monkeypatch.setattr(foods, "food_limiter", AuthRateLimiter(limit=0))
    again = account.post("/api/food/estimate", json={"description": " apple "})
    assert again.status_code == 200 and again.json() == first.json()
    assert len(provider) == 1


def test_cache_is_private_and_lookup_does_not_reveal_another_accounts_estimate(
    account: TestClient, provider: list[httpx.Request],
) -> None:
    first = account.post("/api/food/estimate", json={"description": "apple"}).json()
    account.post("/api/auth/logout")
    register(account)
    response = account.get("/api/food/estimates/" + str(first["id"]))
    assert response.status_code == 404
    second = account.post("/api/food/estimate", json={"description": "apple"})
    assert second.status_code == 201 and second.json()["id"] != first["id"]
    assert len(provider) == 2


def test_missing_saved_estimates_return_404(account: TestClient) -> None:
    assert account.get("/api/food/estimates/999999999").status_code == 404
    assert account.get("/api/food/estimates/0").status_code == 422


@pytest.mark.parametrize("data", [
    {}, {"description": ""}, {"description": " \n "}, {"description": "a" * 2001},
    {"description": 123}, {"description": "apple", "user_id": 5},
    {"description": "apple", "calories": 5},
])
def test_invalid_food_requests_do_not_call_the_provider(
    account: TestClient, provider: list[httpx.Request], data: dict[str, object],
) -> None:
    response = account.post("/api/food/estimate", json=data)
    assert response.status_code == 422 and not provider
    assert all("input" not in error for error in response.json()["detail"])


@pytest.mark.parametrize("headers", [{"Origin": "https://untrusted.example"}, {"X-CSRF-Protection": "0"}])
def test_food_posts_require_trusted_headers(account: TestClient, provider: list[httpx.Request], headers: dict[str, str]) -> None:
    assert account.post("/api/food/estimate", json={"description": "apple"}, headers=headers).status_code == 403
    assert not provider


@pytest.mark.parametrize("limiter", ["food", "provider"])
def test_new_food_requests_respect_limits_before_calling_groq(
    account: TestClient, provider: list[httpx.Request], monkeypatch: pytest.MonkeyPatch, limiter: str,
) -> None:
    if limiter == "food":
        monkeypatch.setattr(foods, "food_limiter", AuthRateLimiter(limit=0))
    else:
        monkeypatch.setattr(maintenance, "provider_limiter", AuthRateLimiter(limit=0))
    response = account.post("/api/food/estimate", json={"description": "apple"})
    assert response.status_code == 429 and response.headers["retry-after"] == "60" and not provider


def test_cooking_and_serving_variants_have_distinct_saved_records(
    account: TestClient, provider: list[httpx.Request],
) -> None:
    descriptions = ["egg", "fried egg", "fried egg cooked with 1 tablespoon of butter"]
    ids = [account.post("/api/food/estimate", json={"description": text}).json()["id"] for text in descriptions]
    assert len(set(ids)) == 3 and len(provider) == 3


@pytest.mark.parametrize("status,expected", [(429, 429), (401, 503), (500, 503), (200, 502)])
def test_provider_failures_do_not_save_or_expose_response_bodies(
    account: TestClient, status: int, expected: int, db_session: Session,
) -> None:
    groq = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(
        lambda _: httpx.Response(status, text="private-provider-debug", headers={"Retry-After": "90"}),
    ))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: groq
    try:
        response = account.post("/api/food/estimate", json={"description": "apple"})
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    assert response.status_code == expected and "private-provider-debug" not in response.text
    assert owned_count(account, db_session) == 0
    if status == 429:
        assert response.headers["retry-after"] == "90"


def test_timeout_is_reported_without_saving_a_partial_estimate(account: TestClient) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("private-details", request=request)
    groq = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(timeout))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: groq
    try:
        response = account.post("/api/food/estimate", json={"description": "apple"})
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    assert response.status_code == 504 and "private-details" not in response.text


def test_non_food_input_is_not_saved_as_a_zero_calorie_food(account: TestClient, db_session: Session) -> None:
    groq = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(
        lambda _: httpx.Response(200, json=completion(None)),
    ))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: groq
    try:
        response = account.post("/api/food/estimate", json={"description": "an accounting spreadsheet"})
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    assert response.status_code == 422 and "could not identify" in response.json()["detail"]
    assert owned_count(account, db_session) == 0


def test_missing_key_and_cached_results_behave_independently(account: TestClient, provider: list[httpx.Request]) -> None:
    saved = account.post("/api/food/estimate", json={"description": "apple"}).json()
    override = main.app.dependency_overrides.pop(maintenance.get_groq_client)
    try:
        assert account.post("/api/food/estimate", json={"description": "apple"}).json() == saved
        fresh = account.post("/api/food/estimate", json={"description": "banana"})
        assert fresh.status_code == 503 and "GROQ_API_KEY" in fresh.json()["detail"]
    finally:
        main.app.dependency_overrides[maintenance.get_groq_client] = override


def test_late_duplicate_insert_keeps_the_first_saved_estimate(
    account: TestClient, provider: list[httpx.Request], db_session: Session,
) -> None:
    owner = account.get("/api/auth/me").json()["id"]
    first = account.post("/api/food/estimate", json={"description": "apple"}).json()
    repeated = foods.store_estimate(
        db_session, owner, "apple", foods.cache_key("apple", first["model"]),
        first["model"], FoodNutrition.model_validate(APPLE),
    )
    assert repeated.model_dump(mode="json") == first


def test_cache_version_or_model_change_requests_a_new_estimate(
    account: TestClient, provider: list[httpx.Request], monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = account.post("/api/food/estimate", json={"description": "apple"}).json()
    monkeypatch.setattr(foods, "FOOD_PROMPT_VERSION", "food-v2")
    second = account.post("/api/food/estimate", json={"description": "apple"}).json()
    assert second["id"] != first["id"] and len(provider) == 2
    assert foods.cache_key("apple", "model-a") != foods.cache_key("apple", "model-b")
    assert account.get("/api/food/estimates/" + str(first["id"])).json() == first


def test_reasoning_setting_change_creates_a_new_estimate_and_retains_the_old_one(
    account: TestClient, provider: list[httpx.Request], monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = account.post("/api/food/estimate", json={"description": "apple"}).json()
    groq = main.app.dependency_overrides[maintenance.get_groq_client]()
    monkeypatch.setattr(groq, "settings", replace(groq.settings, reasoning_effort="medium"))
    second = account.post("/api/food/estimate", json={"description": "apple"})
    assert second.status_code == 201 and second.json()["id"] != first["id"]
    assert len(provider) == 2
    assert account.get("/api/food/estimates/" + str(first["id"])).json() == first


def test_deleting_the_account_cascades_its_estimates(
    account: TestClient, provider: list[httpx.Request], db_session: Session,
) -> None:
    owner = account.get("/api/auth/me").json()["id"]
    saved = account.post("/api/food/estimate", json={"description": "apple"}).json()
    db_session.execute(delete(User).where(User.id == owner))
    db_session.flush()
    assert db_session.get(FoodEstimate, saved["id"]) is None


def test_provider_quota_is_shared_with_maintenance_estimates(
    account: TestClient, provider: list[httpx.Request], monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(maintenance, "provider_limiter", AuthRateLimiter(limit=1))
    assert account.post("/api/food/estimate", json={"description": "apple"}).status_code == 201
    account.put("/api/profile", json={
        "goal": "maintain", "age": 30, "height_cm": 175, "current_weight_kg": 75,
        "gender": "female", "activity_description": "Walking and gym.",
        "gym_sessions_per_week": 2, "steps_per_day": 6000,
    })
    response = account.post("/api/maintenance/estimate", json={})
    assert response.status_code == 429 and len(provider) == 1


@pytest.mark.parametrize("change", [{"fiber_g": 100}, {"calories": "95"}, {"cooking_assumptions": []}])
def test_invalid_provider_totals_or_missing_assumptions_are_not_saved(
    account: TestClient, db_session: Session, change: dict[str, object],
) -> None:
    groq = GroqClient(GroqSettings(SecretStr("test-only-key")), httpx.MockTransport(
        lambda _: httpx.Response(200, json=completion({**APPLE, **change})),
    ))
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: groq
    try:
        response = account.post("/api/food/estimate", json={"description": "apple"})
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    assert response.status_code == 502 and owned_count(account, db_session) == 0
