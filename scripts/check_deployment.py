import argparse
import json
import re
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen


def read(base: str, path: str) -> tuple[str, str]:
    with urlopen(base + path, timeout=3) as response:
        return response.read().decode("utf-8"), response.headers.get_content_type()


def wait_for_health(base: str) -> None:
    deadline = time.monotonic() + 45
    while True:
        try:
            health, _ = read(base, "/api/health")
            if json.loads(health) != {"status": "ok"}:
                raise ValueError("Unexpected health response")
            break
        except (URLError, OSError, ValueError):
            if time.monotonic() >= deadline:
                raise SystemExit("The deployment did not become healthy within 45 seconds.") from None
            time.sleep(1)


def check_frontend(base: str) -> None:
    html, content_type = read(base, "/")
    if content_type != "text/html" or 'id="root"' not in html:
        raise SystemExit("The React index page was not served.")
    assets = re.findall(r'(?:src|href)="(/assets/[^"?]+\.(?:js|css))"', html)
    if not assets:
        raise SystemExit("The React build contains no linked assets.")
    for asset in assets:
        content, asset_type = read(base, asset)
        expected = {"text/css"} if asset.endswith(".css") else {"text/javascript", "application/javascript"}
        if not content or asset_type not in expected:
            raise SystemExit("A frontend asset could not be served correctly.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Check the deployed frontend, assets, and API.")
    parser.add_argument("origin", help="For example http://127.0.0.1:18001")
    arguments = parser.parse_args()
    base = arguments.origin.rstrip("/")
    origin = urlsplit(base)
    if (
        origin.scheme not in {"http", "https"} or not origin.hostname
        or origin.username is not None or origin.password is not None
        or origin.path or origin.query or origin.fragment
    ):
        parser.error("Supply an HTTP(S) origin without a path or credentials.")
    wait_for_health(base)
    ready, _ = read(base, "/api/ready")
    if json.loads(ready) != {"status": "ready", "database": "connected"}:
        raise SystemExit("Database readiness failed.")
    check_frontend(base)
    print("Deployment check passed: React page, bundled assets, API health, and database readiness.")


if __name__ == "__main__":
    main()
