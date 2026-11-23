"""Store one validated plan per account and reject stale profile snapshots."""

import hashlib
import json
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from app.auth import DbSession, require_same_origin
from app.groq_client import GroqClient
from app.maintenance import EstimateRequest, estimate_for_profile, get_groq_client
from app.models import NutritionPlan, UserProfile
from app.nutrition import CaloriePlan, GoalProblem, calculate_plan, validate_goal
from app.profiles import CurrentUser, ProfileRead, ProfileWrite, today_utc

router = APIRouter(prefix="/api/plan", tags=["Calorie plan"])


def profile_fingerprint(profile: ProfileRead) -> str:
    fields = profile.model_dump(mode="json", include=set(ProfileWrite.model_fields))
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def read_saved_plan(record: NutritionPlan | None, fingerprint: str) -> CaloriePlan | None:
    if record is None or record.profile_fingerprint != fingerprint:
        return None
    plan = CaloriePlan.model_validate(record.payload)
    if plan.target_date is not None and plan.target_date <= today_utc():
        return None
    return plan


@dataclass(frozen=True)
class PlanContext:
    user_id: int
    profile: ProfileRead
    fingerprint: str
    cached: CaloriePlan | None


def plan_context(user: CurrentUser, db: DbSession) -> PlanContext:
    profile = db.get(UserProfile, user.id)
    if profile is None:
        raise HTTPException(409, "Save your onboarding profile before creating a calorie plan.")
    snapshot = ProfileRead.model_validate(profile)
    fingerprint = profile_fingerprint(snapshot)
    cached = read_saved_plan(db.get(NutritionPlan, user.id), fingerprint)
    return PlanContext(user.id, snapshot, fingerprint, cached)


Context = Annotated[PlanContext, Depends(plan_context)]


@router.get("", response_model=CaloriePlan)
def get_plan(context: Context) -> CaloriePlan:
    if context.cached is None:
        raise HTTPException(404, "Create a plan for your current profile and target date.")
    return context.cached


def store_plan(db: DbSession, context: PlanContext, plan: CaloriePlan) -> CaloriePlan:
    profile = db.scalar(
        select(UserProfile).where(UserProfile.user_id == context.user_id)
        .with_for_update().execution_options(populate_existing=True)
    )
    if profile is None or profile_fingerprint(ProfileRead.model_validate(profile)) != context.fingerprint:
        db.rollback()
        raise HTTPException(409, "Your profile changed while the plan was being created. Refresh and try again.")
    # Serializing on the profile row also makes concurrent first requests safe.
    record = db.get(NutritionPlan, context.user_id, populate_existing=True)
    existing = read_saved_plan(record, context.fingerprint)
    if existing is not None:
        db.commit()
        return existing
    if record is None:
        record = NutritionPlan(user_id=context.user_id)
        db.add(record)
    record.profile_fingerprint = context.fingerprint
    record.payload = plan.model_dump(mode="json")
    db.commit()
    return plan


@router.post(
    "", response_model=CaloriePlan, dependencies=[Depends(require_same_origin)],
    responses={201: {"model": CaloriePlan, "description": "New plan saved."}},
)
async def create_plan(
    _data: EstimateRequest, response: Response, context: Context, db: DbSession,
    groq: Annotated[GroqClient, Depends(get_groq_client)],
) -> CaloriePlan:
    """Send {}. Reuse a current plan without spending more Groq quota."""
    if context.cached is not None:
        return context.cached
    try:
        # Reject implausible dates/weights before making a provider request.
        validate_goal(context.profile, today_utc())
        estimate = await estimate_for_profile(context.profile, context.user_id, groq)
        plan = calculate_plan(context.profile, estimate, today_utc())
    except GoalProblem as error:
        raise HTTPException(422, error.detail) from None
    saved = await run_in_threadpool(store_plan, db, context, plan)
    response.status_code = 201
    return saved
