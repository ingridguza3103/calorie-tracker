"""Authenticated food estimation; saved estimates are not diary entries."""

import hashlib
import json
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from starlette.concurrency import run_in_threadpool

from app import maintenance
from app.auth import DbSession, require_same_origin
from app.food_nutrition import FoodNutrition
from app.groq_client import GroqClient, GroqError
from app.maintenance import get_groq_client
from app.models import FoodEstimate
from app.profiles import CurrentUser
from app.rate_limit import AuthRateLimiter

router = APIRouter(prefix="/api/food", tags=["Food estimates"])
food_limiter = AuthRateLimiter(limit=6)
FOOD_PROMPT_VERSION = "food-v3-notes"


class FoodEstimateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000, strict=True),
    ]


class FoodEstimateRead(BaseModel):
    id: int
    description: str
    food: FoodNutrition
    model: str
    estimated_at: datetime


def cache_key(description: str, model: str, reasoning_effort: str = "low") -> str:
    canonical = json.dumps([FOOD_PROMPT_VERSION, model, reasoning_effort, description], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def read_estimate(record: FoodEstimate) -> FoodEstimateRead:
    return FoodEstimateRead(
        id=record.id, description=record.description, food=FoodNutrition.model_validate(record.payload),
        model=record.model, estimated_at=record.estimated_at,
    )


def find_cached(db: DbSession, user_id: int, key: str) -> FoodEstimateRead | None:
    record = db.scalar(select(FoodEstimate).where(FoodEstimate.user_id == user_id, FoodEstimate.cache_key == key))
    return read_estimate(record) if record is not None else None


def store_estimate(
    db: DbSession, user_id: int, description: str, key: str, model: str, food: FoodNutrition,
) -> FoodEstimateRead:
    record = db.scalar(
        insert(FoodEstimate).values(
            user_id=user_id, description=description, cache_key=key,
            model=model, payload=food.model_dump(mode="json"),
        ).on_conflict_do_nothing(constraint="uq_food_estimates_user_cache").returning(FoodEstimate)
    )
    if record is None:
        record = db.scalar(select(FoodEstimate).where(FoodEstimate.user_id == user_id, FoodEstimate.cache_key == key))
    result = read_estimate(record)
    db.commit()
    return result


@router.get("/estimates/{estimate_id}", response_model=FoodEstimateRead)
def get_food_estimate(estimate_id: Annotated[int, Path(gt=0)], user: CurrentUser, db: DbSession) -> FoodEstimateRead:
    record = db.scalar(select(FoodEstimate).where(FoodEstimate.id == estimate_id, FoodEstimate.user_id == user.id))
    if record is None:
        raise HTTPException(404, "Food estimate not found.")
    return read_estimate(record)


@router.post(
    "/estimate", response_model=FoodEstimateRead, dependencies=[Depends(require_same_origin)],
    responses={201: {"model": FoodEstimateRead, "description": "New food estimate saved."}},
)
async def estimate_food(
    data: FoodEstimateRequest, response: Response, user: CurrentUser, db: DbSession,
    groq: Annotated[GroqClient, Depends(get_groq_client)],
) -> FoodEstimateRead:
    """Estimate the complete described serving, reusing an identical saved request."""
    user_id = user.id
    key = cache_key(data.description, groq.settings.model, groq.settings.reasoning_effort)
    cached = await run_in_threadpool(find_cached, db, user_id, key)
    if cached is not None:
        return cached
    if groq.settings.api_key.get_secret_value():
        food_limiter.check(str(user_id))
        maintenance.provider_limiter.check("groq")
    try:
        interpretation = await groq.estimate_food(data.description)
    except GroqError as error:
        headers = {"Retry-After": str(error.retry_after)} if error.retry_after is not None else None
        raise HTTPException(error.status_code, error.detail, headers=headers) from None
    if interpretation.food is None:
        raise HTTPException(422, "We could not identify a food or drink. Describe the food, its serving, and how it was prepared.")
    result = await run_in_threadpool(
        store_estimate, db, user_id, data.description, key, groq.settings.model, interpretation.food,
    )
    response.status_code = 201
    return result
