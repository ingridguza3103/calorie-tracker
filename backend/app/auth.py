import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from pwdlib import PasswordHash
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import config
from app.database import get_db
from app.models import AuthSession, User
from app.rate_limit import check_auth_rate_limit

router = APIRouter(prefix="/api/auth", tags=["Accounts"])
DbSession = Annotated[Session, Depends(get_db)]
password_hasher = PasswordHash.recommended()
dummy_hash = password_hasher.hash(secrets.token_urlsafe(32))


class Registration(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9]+$")
    password: SecretStr = Field(min_length=8, max_length=128)


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: SecretStr = Field(min_length=1, max_length=128)


class PublicUser(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    created_at: datetime


def require_same_origin(
    request: Request,
    x_csrf_protection: Annotated[
        str | None,
        Header(alias="X-CSRF-Protection", description="Send 1 for account changes."),
    ] = None,
) -> None:
    """Custom headers require preflight; only the configured browser origins may mutate."""
    origin = request.headers.get("origin")
    if x_csrf_protection != "1" or (
        origin is not None and origin not in config.ALLOWED_ORIGINS
    ):
        raise HTTPException(status_code=403, detail="Request origin could not be verified.")


def hash_token(token: str) -> str:
    """Hash a high-entropy random session token, never a user password."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def begin_session(user: User, request: Request, response: Response, db: Session) -> None:
    previous = request.cookies.get(config.SESSION_COOKIE_NAME)
    if previous:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(previous)))

    now = datetime.now(UTC)
    db.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user.id,
            AuthSession.expires_at <= now,
        )
    )
    token = secrets.token_urlsafe(32)
    db.add(
        AuthSession(
            token_hash=hash_token(token),
            user_id=user.id,
            expires_at=now + timedelta(seconds=config.SESSION_LIFETIME_SECONDS),
        )
    )
    db.commit()
    response.set_cookie(
        key=config.SESSION_COOKIE_NAME,
        value=token,
        max_age=config.SESSION_LIFETIME_SECONDS,
        httponly=True,
        secure=config.SESSION_COOKIE_SECURE,
        samesite="lax",
        path="/api",
    )


def get_current_user(request: Request, db: DbSession) -> User:
    token = request.cookies.get(config.SESSION_COOKIE_NAME)
    if token:
        user = db.scalar(
            select(User)
            .join(AuthSession, AuthSession.user_id == User.id)
            .where(
                AuthSession.token_hash == hash_token(token),
                AuthSession.expires_at > datetime.now(UTC),
            )
        )
        if user is not None:
            return user
    raise HTTPException(status_code=401, detail="Please log in to continue.")


@router.post(
    "/register",
    status_code=201,
    response_model=PublicUser,
    dependencies=[Depends(require_same_origin), Depends(check_auth_rate_limit)],
)
def register(data: Registration, request: Request, response: Response, db: DbSession) -> User:
    user = User(
        username=data.username,
        password_hash=password_hasher.hash(data.password.get_secret_value()),
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="That username is already taken.") from None

    begin_session(user, request, response, db)
    return user


@router.post(
    "/login",
    response_model=PublicUser,
    dependencies=[Depends(require_same_origin), Depends(check_auth_rate_limit)],
)
def login(data: Credentials, request: Request, response: Response, db: DbSession) -> User:
    user = db.scalar(select(User).where(User.username == data.username))
    valid = password_hasher.verify(
        data.password.get_secret_value(),
        user.password_hash if user is not None else dummy_hash,
    )
    if not valid or user is None:
        raise HTTPException(status_code=401, detail="Incorrect username or password.")

    begin_session(user, request, response, db)
    return user


@router.get("/me", response_model=PublicUser)
def me(user: Annotated[User, Depends(get_current_user)]) -> User:
    return user


@router.post("/logout", status_code=204, dependencies=[Depends(require_same_origin)])
def logout(request: Request, response: Response, db: DbSession) -> None:
    token = request.cookies.get(config.SESSION_COOKIE_NAME)
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        db.commit()
    response.delete_cookie(
        key=config.SESSION_COOKIE_NAME,
        path="/api",
        httponly=True,
        secure=config.SESSION_COOKIE_SECURE,
        samesite="lax",
    )
