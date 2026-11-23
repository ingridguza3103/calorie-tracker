from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

from app.config import PROJECT_ROOT
from app.main import create_app as create_api_app


class FrontendFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.media_type == "text/html":
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(frontend_dist: Path | None = None) -> FastAPI:
    """Serve the built frontend and API from one origin in production."""
    api = create_api_app()
    directory = frontend_dist if frontend_dist is not None else PROJECT_ROOT / "frontend" / "dist"
    api.mount("/", FrontendFiles(directory=directory, html=True), name="frontend")
    return api
