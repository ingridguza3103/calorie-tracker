import json
import os
from pathlib import Path


THRESHOLD = 80
ROOT = Path(__file__).resolve().parents[1]


def describe(covered: int, total: int) -> str:
    return f"{100 * covered / total:.2f}% ({covered}/{total})" if total else "—"


def main() -> None:
    try:
        python = json.loads((ROOT / "backend/coverage.json").read_text())["totals"]
        react = json.loads((ROOT / "frontend/coverage/coverage-summary.json").read_text())["total"]
        results = [
            (
                "FastAPI",
                python["covered_lines"],
                python["num_statements"],
                python["covered_branches"],
                python["num_branches"],
            ),
            (
                "React",
                react["lines"]["covered"],
                react["lines"]["total"],
                react["branches"]["covered"],
                react["branches"]["total"],
            ),
        ]
    except (OSError, KeyError, TypeError, ValueError) as error:
        raise SystemExit(f"Could not read both coverage reports: {error}") from error

    covered = total = 0
    summary = [
        "## Application coverage",
        "",
        "| App | Lines | Branches |",
        "|---|---:|---:|",
    ]
    for app, lines_covered, lines_total, branches_covered, branches_total in results:
        if not lines_total:
            raise SystemExit(f"{app} contributed no executable lines to the coverage report.")
        covered += lines_covered + branches_covered
        total += lines_total + branches_total
        summary.append(
            f"| {app} | {describe(lines_covered, lines_total)} | "
            f"{describe(branches_covered, branches_total)} |"
        )

    passed = 100 * covered >= THRESHOLD * total
    status = "passed" if passed else "failed"
    summary.extend(
        [
            "",
            f"**Combined line and branch coverage:** {describe(covered, total)}.",
            f"**Required:** {THRESHOLD}%. Coverage gate {status}.",
            "",
        ]
    )
    report = "\n".join(summary)
    print(report)
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with Path(summary_file).open("a", encoding="utf-8") as output:
            output.write(report)
    if not passed:
        raise SystemExit(f"Combined application coverage is below {THRESHOLD}%.")


if __name__ == "__main__":
    main()
