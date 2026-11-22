import json
from pathlib import Path

MINIMUM_COVERAGE = 80


def main() -> None:
    backend = json.loads(
        Path("backend/coverage.json").read_text(encoding="utf-8")
    )["totals"]
    frontend = json.loads(
        Path("frontend/coverage/coverage-summary.json").read_text(encoding="utf-8")
    )["total"]["lines"]

    reports = {
        "Backend": (backend["covered_lines"], backend["num_statements"]),
        "Frontend": (frontend["covered"], frontend["total"]),
    }

    covered_total = 0
    line_total = 0

    for name, (covered, total) in reports.items():
        if total <= 0 or not 0 <= covered <= total:
            raise SystemExit(f"{name}: empty or invalid coverage report")

        print(f"{name}: {covered / total:.2%} ({covered}/{total} lines)")
        covered_total += covered
        line_total += total

    print(
        f"Combined line coverage: {covered_total / line_total:.2%} "
        f"(minimum {MINIMUM_COVERAGE}%)"
    )

    if covered_total * 100 < MINIMUM_COVERAGE * line_total:
        raise SystemExit("Coverage is below the required minimum.")


if __name__ == "__main__":
    main()