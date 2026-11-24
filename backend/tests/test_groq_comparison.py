import argparse
import asyncio
import json
from pathlib import Path

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


@pytest.fixture
def report_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    monkeypatch.setattr(comparison, "ROOT", root)
    monkeypatch.setattr(comparison, "load_dotenv", lambda *args, **kwargs: False)
    return root


@pytest.mark.parametrize("relative", [
    "reports/groq-comparison.json", "reports/groq-medium.json",
    "reports/nested/results.json", "reports/nested/../normalized.json",
])
def test_report_output_normalizes_valid_paths_without_creating_files(report_root: Path, relative: str) -> None:
    output = comparison.report_output(Path(relative))
    assert output == (report_root / relative).resolve()
    assert not (report_root / "reports").exists()


def test_report_output_accepts_absolute_paths_inside_the_report_directory(report_root: Path) -> None:
    output = report_root / "reports" / "custom.json"
    assert comparison.report_output(output) == output


@pytest.mark.parametrize("relative", [
    "../outside.json", "reports/../../outside.json", "reports/../outside.json",
    "reports-secret/result.json", "README.md", "reports/result.txt", "reports", "reports/.",
])
def test_report_output_rejects_escaping_paths_partial_prefixes_and_non_json_files(report_root: Path, relative: str) -> None:
    with pytest.raises(ValueError, match="inside the project's reports directory"):
        comparison.report_output(Path(relative))


def test_report_output_rejects_absolute_paths_outside_reports(report_root: Path) -> None:
    with pytest.raises(ValueError):
        comparison.report_output(report_root.parent / "outside.json")


@pytest.mark.parametrize("kind", ["reports", "parent", "file", "loop"])
def test_report_output_rejects_symlink_escapes_and_loops(report_root: Path, kind: str) -> None:
    outside = report_root.parent / "outside"
    outside.mkdir()
    protected = outside / "result.json"
    protected.write_text("keep", encoding="utf-8")
    reports = report_root / "reports"
    if kind == "reports":
        reports.symlink_to(outside, target_is_directory=True)
        output = reports / "result.json"
    else:
        reports.mkdir()
        output = reports / "result.json"
        if kind == "parent":
            (reports / "linked").symlink_to(outside, target_is_directory=True)
            output = reports / "linked" / "result.json"
        elif kind == "file":
            output.symlink_to(protected)
        else:
            output.symlink_to(output.name)
    with pytest.raises(ValueError):
        comparison.report_output(output)
    assert protected.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize("kind", ["report_directory", "reports_is_file"])
def test_report_output_rejects_non_file_destinations(report_root: Path, kind: str) -> None:
    if kind == "report_directory":
        (report_root / "reports" / "folder.json").mkdir(parents=True)
        output = Path("reports/folder.json")
    else:
        (report_root / "reports").write_text("keep", encoding="utf-8")
        output = Path("reports/result.json")
    with pytest.raises(ValueError):
        comparison.report_output(output)


@pytest.mark.parametrize("arguments", [
    ["--output", "../outside.json"], ["--report", "../outside.json"],
    ["--report", "/tmp/outside.json"], ["--report", "reports/groq-medium.json"],
    ["--report", "STANDARD"],
])
def test_main_rejects_path_arguments_before_any_provider_calls(
    report_root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    arguments: list[str],
) -> None:
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid output must be rejected before comparing models.")

    monkeypatch.setattr(comparison, "compare", forbidden)
    monkeypatch.setattr(comparison.sys, "argv", ["compare_groq.py", "--run", *arguments])
    with pytest.raises(SystemExit) as error:
        comparison.main()
    assert error.value.code == 2
    assert "error:" in capsys.readouterr().err
    assert not (report_root / "reports").exists()
    assert not (report_root.parent / "outside.json").exists()


@pytest.mark.parametrize("redirect", ["directory", "file"])
def test_main_rejects_redirected_fixed_destinations_before_any_provider_calls(
    report_root: Path, monkeypatch: pytest.MonkeyPatch, redirect: str,
) -> None:
    outside = report_root.parent / "outside"
    outside.mkdir()
    protected = outside / "groq-comparison.json"
    protected.write_text("keep", encoding="utf-8")
    reports = report_root / "reports"
    if redirect == "directory":
        reports.symlink_to(outside, target_is_directory=True)
    else:
        reports.mkdir()
        (reports / "groq-comparison.json").symlink_to(protected)

    def forbidden(*args, **kwargs):
        pytest.fail("A redirected destination must be rejected before comparing models.")

    monkeypatch.setattr(comparison, "compare", forbidden)
    monkeypatch.setattr(comparison.sys, "argv", ["compare_groq.py", "--run"])
    with pytest.raises(SystemExit) as error:
        comparison.main()
    assert error.value.code == 2
    assert protected.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize("preset,filename", [
    (None, "groq-comparison.json"), ("standard", "groq-comparison.json"),
    ("medium", "groq-medium.json"), ("high", "groq-high.json"),
])
@pytest.mark.parametrize("existing", [False, True])
def test_main_writes_only_the_selected_fixed_report_and_can_replace_an_existing_report(
    report_root: Path, monkeypatch: pytest.MonkeyPatch, preset: str | None,
    filename: str, existing: bool,
) -> None:
    async def compare(args):
        return {"rows": [{"status": "pass"}], "live": args.run}

    output = report_root / "reports" / filename
    if existing:
        output.parent.mkdir(parents=True)
        output.write_text("old report", encoding="utf-8")
    monkeypatch.setattr(comparison, "compare", compare)
    monkeypatch.setattr(comparison.sys, "argv", ["compare_groq.py", "--run"] + (["--report", preset] if preset else []))
    comparison.main()
    assert json.loads(output.read_text(encoding="utf-8")) == {"rows": [{"status": "pass"}], "live": True}
    assert list(output.parent.iterdir()) == [output]


def test_main_dry_run_validates_the_destination_but_writes_nothing(
    report_root: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(comparison.sys, "argv", ["compare_groq.py", "--cases", "apple"])
    comparison.main()
    report = json.loads(capsys.readouterr().out)
    assert not report["live"] and report["rows"] == []
    assert not (report_root / "reports").exists()


def test_main_rechecks_a_report_directory_redirected_while_the_provider_runs(
    report_root: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    outside = report_root.parent / "outside"
    outside.mkdir()
    protected = outside / "groq-comparison.json"
    protected.write_text("keep", encoding="utf-8")

    async def compare(args):
        (report_root / "reports").symlink_to(outside, target_is_directory=True)
        return {"rows": [{"status": "pass"}]}

    monkeypatch.setattr(comparison, "compare", compare)
    monkeypatch.setattr(comparison.sys, "argv", ["compare_groq.py", "--run"])
    with pytest.raises(SystemExit, match="Could not save the report"):
        comparison.main()
    assert protected.read_text(encoding="utf-8") == "keep"
