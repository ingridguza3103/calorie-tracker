from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import RequestResponseEndpoint

from app.database import engine
from app.auth import router as auth_router
from app.profiles import router as profile_router
from app.maintenance import router as maintenance_router

async def prevent_private_caching(
    request: Request, call_next: RequestResponseEndpoint,
) -> Response:
    response = await call_next(request)
    if request.url.path.startswith(("/api/auth/", "/api/profile", "/api/maintenance")):
        response.headers["Cache-Control"] = "no-store"
    return response


async def safe_validation_errors(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Validation responses must never echo submitted passwords."""
    details = [
        {"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": details})


def health() -> dict[str, str]:
    return {"status": "ok"}


def ready() -> dict[str, str]:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise HTTPException(
            status_code=503,
            detail="Database unavailable",
        ) from None

    return {"status": "ready", "database": "connected"}


def create_app() -> FastAPI:
    api = FastAPI(title="Calorie Tracker API", version="0.1.0")
    api.include_router(auth_router)
    api.include_router(profile_router)
    api.include_router(maintenance_router)
    api.middleware("http")(prevent_private_caching)
    api.add_exception_handler(RequestValidationError, safe_validation_errors)
    api.add_api_route("/api/health", health, methods=["GET"])
    api.add_api_route("/api/ready", ready, methods=["GET"])
    return api


app = create_app()
