import json
import secrets
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import main, maintenance
from app.groq_client import GroqClient, GroqSettings
from app.models import DiaryEntry, FoodEstimate, NutritionPlan, User
from app.rate_limit import AuthRateLimiter

DAY = "2026-11-23"
OTHER_DAY = "2026-11-24"


def register(client: TestClient) -> int:
    response = client.post("/api/auth/register", json={
        "username": "Diary" + secrets.token_hex(8), "password": secrets.token_urlsafe(24),
    })
    assert response.status_code == 201
    return response.json()["id"]


def food(db: Session, owner: int, calories: int = 95) -> FoodEstimate:
    record = FoodEstimate(user_id=owner, cache_key=secrets.token_hex(32), description="apple",
                          model="test-model", payload={
        "name": "Apple", "serving_description": "One medium apple.", "estimated_weight_g": 182,
        "calories": calories, "protein_g": 0.5, "carbohydrate_g": 25.1, "fat_g": 0.3, "fiber_g": 4.4,
        "serving_assumptions": ["Assumed: one medium apple."],
        "cooking_assumptions": ["Assumed: raw, no added fat."],
    })
    db.add(record)
    db.flush()
    return record


@pytest.fixture
def account(client: TestClient, db_session: Session) -> tuple[TestClient, int, FoodEstimate]:
    owner = register(client)
    return client, owner, food(db_session, owner)


def data(estimate: FoodEstimate, **changes: object) -> dict[str, object]:
    return {"id": str(uuid4()), "food_estimate_id": estimate.id, "entry_date": DAY, "servings": 1, **changes}


def create(account, **changes):
    client, _, estimate = account
    payload = data(estimate, **changes)
    response = client.post("/api/diary/entries", json=payload)
    assert response.status_code == 201, response.text
    return payload, response.json()


def day(client: TestClient, value: str = DAY) -> dict:
    response = client.get("/api/diary", params={"date": value})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def edit_payload(entry: dict, **changes) -> dict:
    return {"food_estimate_id": entry["estimate"]["id"], "entry_date": entry["entry_date"],
            "servings": entry["servings"], "version": entry["version"], **changes}


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/diary?date=" + DAY, None),
    ("POST", "/api/diary/entries", {"id": str(uuid4()), "food_estimate_id": 1, "entry_date": DAY}),
    ("PUT", "/api/diary/entries/" + str(uuid4()), {"food_estimate_id": 1, "entry_date": DAY, "version": 1}),
    ("DELETE", "/api/diary/entries/" + str(uuid4()) + "?version=1", None),
])
def test_diary_requires_authentication(client, method, path, body):
    response = client.request(method, path, json=body)
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("value", [None, "", "2026-1-1", "2026-02-30", "2026-11-23T00:00:00Z", "1795382400"])
def test_day_requires_a_real_explicit_calendar_date(account, value):
    client, _, _ = account
    response = client.get("/api/diary", params={} if value is None else {"date": value})
    assert response.status_code == 422


def test_empty_diary_works_without_profile_or_plan(account):
    client, _, _ = account
    result = day(client)
    assert result == {"date": DAY, "entries": [], "totals": {
        "calories": 0, "protein_g": 0, "carbohydrate_g": 0, "fat_g": 0, "fiber_g": 0,
    }, "targets": None, "remaining_calories": None, "calorie_progress": None}


def test_saves_snapshot_portion_and_assumptions_then_scales_and_sums_displayed_values(account, db_session):
    client, owner, estimate = account
    _, first = create(account, servings=0.5)
    _, second = create(account, servings=2)
    assert first["totals"] == {"calories": 48, "protein_g": 0.3, "carbohydrate_g": 12.6, "fat_g": 0.2, "fiber_g": 2.2}
    assert second["totals"]["calories"] == 190
    result = day(client)
    assert {row["id"] for row in result["entries"]} == {first["id"], second["id"]}
    assert result["totals"] == {"calories": 238, "protein_g": 1.3, "carbohydrate_g": 62.8, "fat_g": 0.8, "fiber_g": 11.0}
    assert first["estimate"]["food"] == estimate.payload
    stored = db_session.get(DiaryEntry, UUID(first["id"]))
    assert stored.user_id == owner and stored.servings == Decimal("0.50") and stored.version == 1
    assert first["created_at"] and first["updated_at"]


def test_dates_stay_explicit_even_when_created_at_falls_on_another_utc_day(account, db_session):
    client, _, _ = account
    _, entry = create(account, entry_date="2026-11-22")
    db_session.get(DiaryEntry, UUID(entry["id"])).created_at = datetime(2026, 11, 23, 0, 30, tzinfo=UTC)
    db_session.flush()
    assert not day(client)["entries"]
    assert day(client, "2026-11-22")["entries"][0]["id"] == entry["id"]


def test_duplicate_save_retries_once_but_intentional_repeat_counts_twice(account, db_session):
    client, owner, _ = account
    payload, entry = create(account)
    again = client.post("/api/diary/entries", json=payload)
    assert again.status_code == 200 and again.json() == entry
    create(account)
    assert len(day(client)["entries"]) == 2
    assert db_session.scalar(select(func.count()).select_from(DiaryEntry).where(DiaryEntry.user_id == owner)) == 2
    assert day(client)["totals"]["calories"] == 190


def test_same_uuid_different_payload_conflicts_without_mutation(account):
    client, _, _ = account
    payload, _ = create(account)
    for changes in ({"servings": 2}, {"entry_date": OTHER_DAY}):
        assert client.post("/api/diary/entries", json={**payload, **changes}).status_code == 409
    assert day(client)["totals"]["calories"] == 95


def test_edit_servings_move_date_replace_food_and_replay_previous_create(account, db_session):
    client, owner, _ = account
    payload, entry = create(account)
    replacement = food(db_session, owner, calories=200)
    changes = edit_payload(entry, food_estimate_id=replacement.id, entry_date=OTHER_DAY, servings=1.25)
    updated = client.put("/api/diary/entries/" + entry["id"], json=changes)
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["version"] == 2 and body["totals"]["calories"] == 250
    assert body["estimate"]["id"] == replacement.id
    assert day(client)["entries"] == []
    assert day(client, OTHER_DAY)["totals"]["calories"] == 250
    # Lost replies may replay a PUT or the original POST; neither reverts a newer entry.
    assert client.put("/api/diary/entries/" + entry["id"], json=changes).json() == body
    replay = client.post("/api/diary/entries", json=payload)
    assert replay.status_code == 200 and replay.json() == body


def test_stale_edits_and_deletes_cannot_overwrite_another_tabs_change(account):
    client, _, _ = account
    _, entry = create(account)
    url = "/api/diary/entries/" + entry["id"]
    assert client.put(url, json=edit_payload(entry, servings=2)).status_code == 200
    assert client.put(url, json=edit_payload(entry, servings=3)).status_code == 409
    assert client.delete(url + "?version=1").status_code == 409
    assert day(client)["totals"]["calories"] == 190


def test_delete_is_repeatable_and_late_add_retry_cannot_resurrect_it(account, db_session):
    client, _, _ = account
    payload, entry = create(account)
    url = "/api/diary/entries/" + entry["id"]
    for _ in range(2):
        response = client.delete(url + "?version=1")
        assert response.status_code == 204 and response.content == b""
        assert response.headers["cache-control"] == "no-store"
    assert day(client)["entries"] == [] and day(client)["totals"]["calories"] == 0
    assert client.post("/api/diary/entries", json=payload).status_code == 409
    assert client.put(url, json=edit_payload(entry)).status_code == 404
    assert db_session.get(DiaryEntry, UUID(entry["id"])).deleted_at is not None


def test_zero_calorie_entries_are_retained(account, db_session):
    client, owner, _ = account
    zero = food(db_session, owner, calories=0)
    assert client.post("/api/diary/entries", json=data(zero)).status_code == 201
    assert len(day(client)["entries"]) == 1 and day(client)["totals"]["calories"] == 0


def test_accounts_cannot_read_change_or_attach_another_accounts_food(account, db_session):
    client, _, estimate = account
    payload, entry = create(account)
    client.post("/api/auth/logout")
    owner = register(client)
    mine = food(db_session, owner)
    assert day(client)["entries"] == []
    assert client.post("/api/diary/entries", json=data(estimate)).status_code == 404
    assert client.post("/api/diary/entries", json=data(mine, id=payload["id"])).status_code == 409
    url = "/api/diary/entries/" + entry["id"]
    assert client.put(url, json=edit_payload(entry)).status_code == 404
    assert client.delete(url + "?version=1").status_code == 404
    _, my_entry = create((client, owner, mine))
    assert client.put("/api/diary/entries/" + my_entry["id"], json=edit_payload(my_entry, food_estimate_id=estimate.id)).status_code == 404


@pytest.mark.parametrize("changes", [
    {"servings": 0}, {"servings": -1}, {"servings": 20.01}, {"servings": 0.001},
    {"servings": "1"}, {"servings": True}, {"servings": None}, {"servings": float("inf")},
    {"entry_date": "2026-02-30"}, {"entry_date": "2026-11-23T00:00:00Z"}, {"entry_date": 1795382400},
    {"food_estimate_id": "1"}, {"food_estimate_id": 0}, {"food_estimate_id": True},
    {"id": "bad"}, {"id": "00000000-0000-1000-8000-000000000000"},
    {"user_id": 1}, {"calories": 1},
])
def test_invalid_creates_cannot_change_totals(account, changes):
    client, _, estimate = account
    # Use raw JSON for infinity because HTTPX's JSON encoder intentionally rejects it.
    response = client.post("/api/diary/entries", content=json.dumps(data(estimate, **changes)), headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert day(client)["entries"] == []
    assert all("input" not in item for item in response.json()["detail"])


@pytest.mark.parametrize("changes", [{"version": 0}, {"version": True}, {"version": "1"}, {"user_id": 1}])
def test_invalid_edits_rejected(account, changes):
    client, _, _ = account
    _, entry = create(account)
    assert client.put("/api/diary/entries/" + entry["id"], json=edit_payload(entry, **changes)).status_code == 422
    assert day(client)["totals"]["calories"] == 95


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE"])
@pytest.mark.parametrize("headers", [{"Origin": "https://untrusted.example"}, {"X-CSRF-Protection": "0"}])
def test_mutations_require_csrf_and_trusted_origin(account, method, headers):
    client, _, estimate = account
    _, entry = create(account)
    path = "/api/diary/entries"
    payload = data(estimate)
    if method != "POST":
        path += "/" + entry["id"]
        payload = edit_payload(entry)
    if method == "DELETE":
        path += "?version=1"
    assert client.request(method, path, json=payload, headers=headers).status_code == 403
    assert day(client)["totals"]["calories"] == 95


def test_missing_entries_estimates_and_delete_version(account):
    client, _, estimate = account
    assert client.post("/api/diary/entries", json=data(estimate, food_estimate_id=2147483647)).status_code == 404
    url = "/api/diary/entries/" + str(uuid4())
    assert client.put(url, json={"food_estimate_id": estimate.id, "entry_date": DAY, "version": 1}).status_code == 404
    assert client.delete(url + "?version=1").status_code == 404
    assert client.delete(url).status_code == 422
    assert client.delete(url + "?version=0").status_code == 422


def test_database_owner_constraint_rejects_cross_account_reference(account, db_session):
    _, _, estimate = account
    other = User(username="Other" + secrets.token_hex(8), password_hash=secrets.token_hex(32))
    db_session.add(other)
    db_session.flush()
    with pytest.raises(IntegrityError):
        with db_session.begin_nested():
            db_session.add(DiaryEntry(id=uuid4(), user_id=other.id, food_estimate_id=estimate.id, entry_date=date(2026, 11, 23),
                                     servings=Decimal("1"), request_fingerprint=secrets.token_hex(32)))
            db_session.flush()


def test_deleting_account_cascades_food_and_diary_without_constraint_failure(account, db_session):
    _, owner, estimate = account
    _, entry = create(account)
    estimate_id = estimate.id
    db_session.execute(delete(User).where(User.id == owner))
    db_session.flush()
    assert db_session.get(FoodEstimate, estimate_id, populate_existing=True) is None
    assert db_session.get(DiaryEntry, UUID(entry["id"]), populate_existing=True) is None


def test_totals_use_current_plan_or_hide_stale_and_expired_targets(account, db_session, monkeypatch):
    client, owner, _ = account
    profile = {"goal": "maintain", "age": 30, "height_cm": 175.5, "current_weight_kg": 75,
               "gender": "female", "activity_description": "Walking.", "gym_sessions_per_week": 2, "steps_per_day": 6000}
    assert client.put("/api/profile", json=profile).status_code == 201
    assert day(client)["targets"] is None
    monkeypatch.setattr(maintenance, "estimate_limiter", AuthRateLimiter(limit=100))
    monkeypatch.setattr(maintenance, "provider_limiter", AuthRateLimiter(limit=100))
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {
        "content": json.dumps({"activity_level": "moderate", "summary": "Walking and gym.", "assumptions": []}),
    }}]}))
    groq = GroqClient(GroqSettings(SecretStr("test-only")), transport)
    main.app.dependency_overrides[maintenance.get_groq_client] = lambda: groq
    try:
        plan = client.post("/api/plan", json={}).json()
    finally:
        main.app.dependency_overrides.pop(maintenance.get_groq_client, None)
    create(account, servings=20)
    create(account, servings=20)
    result = day(client)
    assert result["targets"] == plan["targets"]
    assert result["remaining_calories"] == plan["targets"]["daily_calories"] - 3800
    assert result["calorie_progress"] == round(3800 / plan["targets"]["daily_calories"] * 100, 1) > 100
    assert day(client, "2020-01-01")["targets"] == plan["targets"]
    stored_plan = db_session.get(NutritionPlan, owner)
    saved = dict(stored_plan.payload)
    stored_plan.payload = {**saved, "target_date": (datetime.now(UTC).date() - timedelta(days=1)).isoformat()}
    db_session.flush()
    assert day(client)["targets"] is None
    stored_plan.payload = saved
    db_session.flush()
    assert client.put("/api/profile", json={**profile, "age": 31}).status_code == 200
    assert day(client)["targets"] is None
