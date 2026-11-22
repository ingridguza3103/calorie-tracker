from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import RequestResponseEndpoint

from app.database import engine
from app.auth import router as auth_router

app = FastAPI(
    title="Calorie Tracker API",
    version="0.1.0",
)

app.include_router(auth_router)


@app.middleware("http")
async def prevent_auth_caching(
    request: Request, call_next: RequestResponseEndpoint,
) -> Response:
    response = await call_next(request)
    if request.url.path.startswith("/api/auth/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(RequestValidationError)
async def safe_validation_errors(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Validation responses must never echo submitted passwords."""
    details = [
        {"loc": error["loc"], "msg": error["msg"], "type": error["type"]}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": details})


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/ready")
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
