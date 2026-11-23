"""Private, dated diary entries with scaled totals and safe write retries."""

import hashlib
import json
import re
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import UUID4, BaseModel, BeforeValidator, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.auth import DbSession, require_same_origin
from app.foods import FoodEstimateRead, read_estimate
from app.models import DiaryEntry, FoodEstimate, NutritionPlan, UserProfile
from app.nutrition import NutrientTargets
from app.plans import profile_fingerprint, read_saved_plan
from app.profiles import CurrentUser, ProfileRead

router = APIRouter(prefix="/api/diary", tags=["Food diary"])
GRAM_FIELDS = ("protein_g", "carbohydrate_g", "fat_g", "fiber_g")


def date_only(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is None:
        raise ValueError("Use a calendar date in YYYY-MM-DD format.")
    return value


DateOnly = Annotated[date, BeforeValidator(date_only)]


class EntryFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    food_estimate_id: int = Field(gt=0, strict=True)
    entry_date: DateOnly
    servings: float = Field(default=1, ge=0.01, le=20, multiple_of=0.01, strict=True, allow_inf_nan=False)


class EntryCreate(EntryFields):
    id: UUID4


class EntryUpdate(EntryFields):
    version: int = Field(ge=1, strict=True)


class DiaryTotals(BaseModel):
    calories: int = Field(default=0, ge=0)
    protein_g: float = Field(default=0, ge=0)
    carbohydrate_g: float = Field(default=0, ge=0)
    fat_g: float = Field(default=0, ge=0)
    fiber_g: float = Field(default=0, ge=0)


class EntryRead(BaseModel):
    id: UUID
    entry_date: date
    servings: float
    estimate: FoodEstimateRead
    totals: DiaryTotals
    version: int
    created_at: datetime
    updated_at: datetime


class DiaryDay(BaseModel):
    date: date
    entries: list[EntryRead]
    totals: DiaryTotals
    targets: NutrientTargets | None
    remaining_calories: int | None
    calorie_progress: float | None


def quantity(value: float | Decimal) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"))


def request_fingerprint(data: EntryFields) -> str:
    values = [data.food_estimate_id, data.entry_date.isoformat(), str(quantity(data.servings))]
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode("utf-8")).hexdigest()


def scaled_totals(estimate: FoodEstimateRead, servings: Decimal) -> DiaryTotals:
    values = {
        field: float((Decimal(str(getattr(estimate.food, field))) * servings).quantize(
            Decimal("0.1"), rounding=ROUND_HALF_UP,
        ))
        for field in GRAM_FIELDS
    }
    calories = int((Decimal(estimate.food.calories) * servings).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return DiaryTotals(calories=calories, **values)


def entry_read(entry: DiaryEntry) -> EntryRead:
    estimate = read_estimate(entry.estimate)
    return EntryRead(
        id=entry.id, entry_date=entry.entry_date, servings=float(entry.servings),
        estimate=estimate, totals=scaled_totals(estimate, entry.servings), version=entry.version,
        created_at=entry.created_at, updated_at=entry.updated_at,
    )


def owned_estimate(db: DbSession, user_id: int, estimate_id: int) -> FoodEstimate:
    estimate = db.scalar(select(FoodEstimate).where(FoodEstimate.id == estimate_id, FoodEstimate.user_id == user_id))
    if estimate is None:
        raise HTTPException(404, "Food estimate not found.")
    return estimate


def owned_entry(db: DbSession, user_id: int, entry_id: UUID) -> DiaryEntry:
    entry = db.scalar(
        select(DiaryEntry).where(DiaryEntry.id == entry_id, DiaryEntry.user_id == user_id)
        .with_for_update(of=DiaryEntry).execution_options(populate_existing=True)
    )
    if entry is None:
        raise HTTPException(404, "Diary entry not found.")
    return entry


def current_targets(db: DbSession, user_id: int) -> NutrientTargets | None:
    profile = db.get(UserProfile, user_id)
    if profile is None:
        return None
    snapshot = ProfileRead.model_validate(profile)
    plan = read_saved_plan(db.get(NutritionPlan, user_id), profile_fingerprint(snapshot))
    return plan.targets if plan is not None else None


@router.get("", response_model=DiaryDay)
def get_diary_day(day: Annotated[DateOnly, Query(alias="date")], user: CurrentUser, db: DbSession) -> DiaryDay:
    """The caller supplies a calendar date; the server never defaults to its UTC day."""
    records = db.scalars(
        select(DiaryEntry).where(
            DiaryEntry.user_id == user.id, DiaryEntry.entry_date == day, DiaryEntry.deleted_at.is_(None),
        ).order_by(DiaryEntry.created_at, DiaryEntry.id)
    ).all()
    entries = [entry_read(record) for record in records]
    totals = DiaryTotals(
        calories=sum(entry.totals.calories for entry in entries),
        **{field: float(sum(Decimal(str(getattr(entry.totals, field))) for entry in entries)) for field in GRAM_FIELDS},
    )
    targets = current_targets(db, user.id)
    return DiaryDay(
        date=day, entries=entries, totals=totals, targets=targets,
        remaining_calories=targets.daily_calories - totals.calories if targets else None,
        calorie_progress=round(totals.calories / targets.daily_calories * 100, 1) if targets else None,
    )


@router.post(
    "/entries", response_model=EntryRead, dependencies=[Depends(require_same_origin)],
    responses={201: {"model": EntryRead, "description": "Diary entry created."}},
)
def add_entry(data: EntryCreate, response: Response, user: CurrentUser, db: DbSession) -> EntryRead:
    owned_estimate(db, user.id, data.food_estimate_id)
    fingerprint = request_fingerprint(data)
    created = db.scalar(
        insert(DiaryEntry).values(
            id=data.id, user_id=user.id, food_estimate_id=data.food_estimate_id,
            entry_date=data.entry_date, servings=quantity(data.servings), request_fingerprint=fingerprint,
        ).on_conflict_do_nothing(index_elements=[DiaryEntry.id]).returning(DiaryEntry.id)
    )
    # Scope even a duplicate UUID to its owner; never expose another account's row.
    entry = db.scalar(select(DiaryEntry).where(DiaryEntry.id == data.id, DiaryEntry.user_id == user.id))
    if entry is None or entry.request_fingerprint != fingerprint:
        raise HTTPException(409, "This save identifier belongs to a different entry. Reload the diary.")
    if entry.deleted_at is not None:
        raise HTTPException(409, "This entry was deleted. Reload the diary before adding another.")
    result = entry_read(entry)
    db.commit()
    response.status_code = 201 if created is not None else 200
    return result


def matches(entry: DiaryEntry, data: EntryFields) -> bool:
    return (
        entry.food_estimate_id == data.food_estimate_id and entry.entry_date == data.entry_date
        and entry.servings == quantity(data.servings)
    )


@router.put("/entries/{entry_id}", response_model=EntryRead, dependencies=[Depends(require_same_origin)])
def update_entry(entry_id: UUID, data: EntryUpdate, user: CurrentUser, db: DbSession) -> EntryRead:
    entry = owned_entry(db, user.id, entry_id)
    if entry.deleted_at is not None:
        raise HTTPException(404, "Diary entry not found.")
    if matches(entry, data):
        return entry_read(entry)
    if entry.version != data.version:
        raise HTTPException(409, "This entry changed elsewhere. Reload the diary before editing it.")
    estimate = owned_estimate(db, user.id, data.food_estimate_id)
    entry.food_estimate_id = estimate.id
    entry.estimate = estimate
    entry.entry_date = data.entry_date
    entry.servings = quantity(data.servings)
    entry.version += 1
    db.flush()
    result = entry_read(entry)
    db.commit()
    return result


@router.delete("/entries/{entry_id}", status_code=204, dependencies=[Depends(require_same_origin)])
def delete_entry(entry_id: UUID, version: Annotated[int, Query(ge=1)], user: CurrentUser, db: DbSession) -> None:
    entry = owned_entry(db, user.id, entry_id)
    if entry.deleted_at is not None:
        return
    if entry.version != version:
        raise HTTPException(409, "This entry changed elsewhere. Reload the diary before deleting it.")
    entry.deleted_at = datetime.now(UTC)
    entry.version += 1
    db.commit()
