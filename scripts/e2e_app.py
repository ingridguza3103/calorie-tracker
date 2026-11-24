"""Local-only production UI/API harness; Groq is the sole replaced boundary."""

import json
import os
from pathlib import Path
import subprocess
import sys
from contextlib import asynccontextmanager

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main() -> None:
    # Never inherit a Neon URL, production cookie/origin settings, or a real AI key.
    port = int(os.environ.get("E2E_PORT", "18002"))
    origin = "http://127.0.0.1:" + str(port)
    os.environ.update(DATABASE_URL="", DATABASE_URL_UNPOOLED="", APP_ORIGIN=origin,
                      CALORIE_ALLOWED_ORIGINS=origin, CALORIE_COOKIE_SECURE="false", GROQ_API_KEY="")
    import httpx
    import uvicorn
    from pydantic import SecretStr
    from sqlalchemy import delete, event
    from sqlalchemy.orm import Session

    from app import maintenance, rate_limit
    from app.database import engine
    from app.database_settings import LOCAL_HOSTS
    from app.groq_client import GroqClient, GroqSettings
    from app.models import User
    from app.web import create_app

    if engine.url.host not in LOCAL_HOSTS:
        raise SystemExit("Browser tests require the existing local Docker database on a loopback host.")
    subprocess.run([sys.executable, "-m", "alembic", "-c", "backend/alembic.ini", "upgrade", "head"],
                   cwd=ROOT, check=True)

    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        schema = body["response_format"]["json_schema"]["name"]
        if schema == "food_nutrition":
            value = {
                "recognized": True,
                "food": {
                    "name": "Medium apple", "serving_description": "One medium raw apple.",
                    "estimated_weight_g": 182.0, "calories": 95,
                    "protein_g": 0.5, "carbohydrate_g": 25.1, "fat_g": 0.3, "fiber_g": 4.4,
                    "serving_assumptions": ["Assumed: one medium apple, about 182g."],
                    "cooking_assumptions": ["Assumed: raw; no added cooking fat."],
                },
            }
        else:
            value = {"activity_level": "moderate", "summary": "Regular walking and gym.", "assumptions": []}
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(value)}}]})

    groq = GroqClient(GroqSettings(SecretStr("local-browser-fixture")), httpx.MockTransport(respond))
    created_ids: set[int] = set()

    def record_created_user(_mapper, _connection, user: User) -> None:
        if user.username.startswith("E2E"):
            created_ids.add(user.id)

    @asynccontextmanager
    async def lifespan(_app):
        event.listen(User, "after_insert", record_created_user)
        try:
            yield
        finally:
            event.remove(User, "after_insert", record_created_user)
            # Exact IDs observed by this test-only process; never truncate tables.
            if created_ids:
                with Session(engine) as db:
                    db.execute(delete(User).where(User.id.in_(created_ids)))
                    db.commit()
            engine.dispose()

    api = create_app()
    api.router.lifespan_context = lifespan
    api.dependency_overrides[maintenance.get_groq_client] = lambda: groq
    rate_limit.auth_limiter = rate_limit.AuthRateLimiter(limit=1000)
    maintenance.provider_limiter = rate_limit.AuthRateLimiter(limit=1000)
    maintenance.estimate_limiter = rate_limit.AuthRateLimiter(limit=1000)
    uvicorn.run(api, host="127.0.0.1", port=port, access_log=False)


if __name__ == "__main__":
    main()
