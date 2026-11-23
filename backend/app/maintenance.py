"""Authenticated, explicit maintenance estimates from the saved profile."""

import logging
import math
import os
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.auth import DbSession, require_same_origin
from app.groq_client import (
    ActivityInput, ActivityInterpretation, ActivityLevel, GroqClient, GroqError, load_groq_settings,
)
from app.models import UserProfile
from app.profiles import CurrentUser, ProfileRead
from app.rate_limit import AuthRateLimiter

router = APIRouter(prefix="/api/maintenance", tags=["Maintenance"])
logger = logging.getLogger(__name__)
estimate_limiter = AuthRateLimiter(limit=2)
provider_limiter = AuthRateLimiter(limit=10)
ACTIVITY_FACTORS: dict[ActivityLevel, float] = {
    "sedentary": 1.2, "light": 1.375, "moderate": 1.55, "active": 1.725, "very_active": 1.9,
}


class EstimateRequest(BaseModel):
    """Send {}. All inputs come from the authenticated account's saved profile."""

    model_config = ConfigDict(extra="forbid")


class MaintenanceEstimate(BaseModel):
    resting_calories: int = Field(gt=0, description="Estimated resting energy expenditure, kcal/day.")
    maintenance_calories: int = Field(gt=0, description="Estimated maintenance energy, kcal/day.")
    activity: ActivityInterpretation
    activity_factor: float
    formula: Literal["mifflin_st_jeor"] = "mifflin_st_jeor"
    formula_basis: Literal["female", "male", "midpoint"]
    assumptions: list[str]
    model: str
    profile_updated_at: datetime
    estimated_at: datetime


def get_groq_client() -> GroqClient:
    try:
        return GroqClient(load_groq_settings(os.environ))
    except ValueError:
        logger.warning("Invalid Groq configuration; check the server environment settings.")
        raise HTTPException(status_code=503, detail="AI configuration needs attention on the server.") from None


def resting_energy(profile: ProfileRead) -> tuple[float, Literal["female", "male", "midpoint"], list[str]]:
    basis: Literal["female", "male", "midpoint"]
    assumptions = ["Maintenance is an initial estimate; activity factors are approximate."]
    if profile.gender in {"female", "male"}:
        basis = profile.gender
        coefficient = -161 if basis == "female" else 5
        assumptions.append("The formula uses the selected gender as its sex-based equation input.")
    else:
        basis = "midpoint"
        coefficient = -78
        assumptions.append(
            "No sex-based equation was selected. This estimate uses the midpoint of the female "
            "and male equations as an app approximation; it is not a separately validated equation."
        )
    resting = (
        10 * profile.current_weight_kg + 6.25 * profile.height_cm - 5 * profile.age + coefficient
    )
    if resting < 1:
        raise HTTPException(
            status_code=422,
            detail="These measurements cannot produce a maintenance estimate. Check age, height, and weight.",
        )
    return resting, basis, assumptions


def saved_profile(user: CurrentUser, db: DbSession) -> ProfileRead:
    profile = db.get(UserProfile, user.id)
    if profile is None:
        raise HTTPException(status_code=409, detail="Save your onboarding profile before estimating maintenance.")
    return ProfileRead.model_validate(profile)


@router.post(
    "/estimate", response_model=MaintenanceEstimate,
    dependencies=[Depends(require_same_origin)],
    responses={
        409: {"description": "A saved onboarding profile is required."},
        429: {"description": "Local request limit or Groq quota reached; see Retry-After."},
        502: {"description": "Groq returned an invalid or incomplete structured response."},
        503: {"description": "AI is unconfigured or temporarily unavailable."},
        504: {"description": "The AI request exceeded the configured deadline."},
    },
)
async def estimate_maintenance(
    _data: EstimateRequest,
    user: CurrentUser,
    profile: Annotated[ProfileRead, Depends(saved_profile)],
    groq: Annotated[GroqClient, Depends(get_groq_client)],
) -> MaintenanceEstimate:
    """Send {} and X-CSRF-Protection: 1. This explicitly calls Groq; it does not save a target."""
    return await estimate_for_profile(profile, user.id, groq)


async def estimate_for_profile(profile: ProfileRead, user_id: int, groq: GroqClient) -> MaintenanceEstimate:
    """Shared by explicit maintenance estimates and saved calorie plans."""
    resting, basis, assumptions = resting_energy(profile)
    # No configured key means no provider attempt and no quota consumed.
    if groq.settings.api_key.get_secret_value():
        estimate_limiter.check(str(user_id))
        provider_limiter.check("maintenance")
    activity_input = ActivityInput.model_validate({
        "activity_description": profile.activity_description,
        "gym_sessions_per_week": profile.gym_sessions_per_week,
        "steps_per_day": profile.steps_per_day,
    })
    try:
        activity = await groq.interpret_activity(activity_input)
    except GroqError as error:
        headers = {"Retry-After": str(error.retry_after)} if error.retry_after is not None else None
        raise HTTPException(error.status_code, error.detail, headers=headers) from None
    factor = ACTIVITY_FACTORS[activity.activity_level]
    return MaintenanceEstimate(
        resting_calories=math.floor(resting + 0.5),
        maintenance_calories=math.floor(resting * factor + 0.5),
        activity=activity, activity_factor=factor, formula_basis=basis,
        assumptions=assumptions, model=groq.settings.model,
        profile_updated_at=profile.updated_at, estimated_at=datetime.now(UTC),
    )
