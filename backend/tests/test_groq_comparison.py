import argparse
import asyncio
import json

import httpx
import pytest
from pydantic import SecretStr

from app.food_nutrition import FoodInterpretation
from app.groq_client import GroqSettings
from scripts import compare_groq as comparison

FOOD = {
    "name": "Apple", "serving_description": "One medium apple.",
    "estimated_weight_g": 182, "calories": 95,
    "protein_g": 0.5, "carbohydrate_g": 25.1, "fat_g": 0.3, "fiber_g": 4.4,
    "serving_assumptions": ["Assumed: one medium apple."],
    "cooking_assumptions": ["Assumed: raw; no added fat."],
}


def test_dry_run_sends_nothing_and_needs_no_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args, **kwargs):
        pytest.fail("Dry run must not access Groq settings or open an HTTP client.")

    monkeypatch.setattr(comparison, "load_groq_settings", forbidden)
    monkeypatch.setattr(comparison.httpx, "AsyncClient", forbidden)
    report = asyncio.run(comparison.compare(argparse.Namespace(models=[comparison.MODELS[0]], cases=["apple"], run=False)))
    assert not report["live"] and report["rows"] == [] and report["planned_requests"] == 1


def test_live_sample_records_tokens_and_validated_output_without_credentials_or_reasoning() -> None:
    secret = "test-only-comparison-key"

    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["response_format"]["json_schema"]["strict"] is True
        assert payload["reasoning_effort"] == "low"
        return httpx.Response(200, json={
            "choices": [{"finish_reason": "stop", "message": {
                "content": json.dumps({"recognized": True, "food": FOOD}),
                "reasoning": "private reasoning must not be saved",
            }}],
            "usage": {"prompt_tokens": 600, "completion_tokens": 200, "total_tokens": 800,
                      "completion_tokens_details": {"reasoning_tokens": 40}},
        })

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await comparison.sample(client, comparison.CASES[0], GroqSettings(SecretStr(secret)))

    row = asyncio.run(run())
    assert row["status"] == "pass" and row["total_tokens"] == 800 and row["reasoning_tokens"] == 40
    assert row["result"]["food"]["calories"] == 95 and row["latency_ms"] >= 0
    assert secret not in json.dumps(row) and "private reasoning" not in json.dumps(row)


def test_provider_quota_stops_the_comparison_and_keeps_only_safe_partial_results(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []
    original_client = httpx.AsyncClient

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(429, json={"error": "do not save the raw provider body"})

    monkeypatch.setattr(comparison.httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    monkeypatch.setenv("GROQ_API_KEY", "test-only-comparison-key")
    report = asyncio.run(comparison.compare(argparse.Namespace(
        models=list(comparison.MODELS[:2]), cases=["apple", "egg"], run=True, delay=0, reasoning_effort="low",
    )))
    assert len(calls) == 1 and report["planned_requests"] == 4
    assert report["rows"][0]["http_status"] == 429
    assert "test-only-comparison-key" not in json.dumps(report)
    assert "raw provider body" not in json.dumps(report)


@pytest.mark.parametrize("body", [None, [], {}, {"usage": {"prompt_tokens": True, "completion_tokens": -1}}])
def test_unavailable_token_counts_are_unknown_rather_than_zero(body: object) -> None:
    assert all(value is None for value in comparison.token_counts(body).values())


def test_case_checks_reject_wrong_preparation_and_non_food_recognition() -> None:
    apple = FoodInterpretation.model_validate({"recognized": True, "food": FOOD})
    rejected = FoodInterpretation(recognized=False, food=None)
    assert comparison.assess(comparison.CASES[0], apple) == []
    assert len(comparison.assess(comparison.CASES[1], apple)) == 2
    assert comparison.assess(comparison.CASES[0], rejected)
    non_food = next(case for case in comparison.CASES if case.name == "non-food")
    assert comparison.assess(non_food, apple)
    assert comparison.assess(non_food, rejected) == []
