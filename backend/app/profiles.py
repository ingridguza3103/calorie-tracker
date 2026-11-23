from datetime import UTC, date, datetime
from typing import Annotated, Literal, Self

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import func, update
from sqlalchemy.dialects.postgresql import insert

from app.auth import DbSession, get_current_user, require_same_origin
from app.models import User, UserProfile

router = APIRouter(prefix="/api/profile", tags=["Profile"])
CurrentUser = Annotated[User, Depends(get_current_user)]


def today_utc() -> date:
    return datetime.now(UTC).date()


class ProfileFields(BaseModel):
    goal: Literal["gain", "lose", "maintain"]
    age: int = Field(ge=18, le=120, strict=True, description="Age in completed years; adults only.")
    height_cm: float = Field(ge=50, le=300, strict=True, allow_inf_nan=False)
    current_weight_kg: float = Field(ge=20, le=500, strict=True, allow_inf_nan=False)
    gender: Literal["female", "male", "other", "prefer_not_to_say"]
    activity_description: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=2000, strict=True),
    ]
    gym_sessions_per_week: int = Field(ge=0, le=21, strict=True)
    steps_per_day: int = Field(ge=0, le=100000, strict=True)
    target_weight_kg: float | None = Field(
        default=None, ge=20, le=500, strict=True, allow_inf_nan=False,
    )
    target_date: date | None = Field(default=None, description="Goal date in YYYY-MM-DD format.")


class ProfileWrite(ProfileFields):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_goal(self) -> Self:
        if self.goal == "maintain":
            if self.target_weight_kg is not None or self.target_date is not None:
                raise ValueError("Maintain goals do not use a target weight or deadline.")
            return self

        if self.target_weight_kg is None or self.target_date is None:
            raise ValueError("Gain and lose goals require a target weight and deadline.")
        if self.target_date <= today_utc():
            raise ValueError("The deadline must be later than today (UTC).")
        if self.goal == "gain" and self.target_weight_kg <= self.current_weight_kg:
            raise ValueError("A gain goal needs a target above the current weight.")
        if self.goal == "lose" and self.target_weight_kg >= self.current_weight_kg:
            raise ValueError("A lose goal needs a target below the current weight.")
        return self


class ProfileRead(ProfileFields):
    """Read stored goals without treating an elapsed deadline as invalid data."""

    model_config = ConfigDict(from_attributes=True)

    created_at: datetime
    updated_at: datetime


@router.get("", response_model=ProfileRead)
def get_profile(user: CurrentUser, db: DbSession) -> UserProfile:
    profile = db.get(UserProfile, user.id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Your profile has not been set up yet.")
    return profile


@router.put(
    "",
    response_model=ProfileRead,
    responses={201: {"model": ProfileRead, "description": "Profile created."}},
    dependencies=[Depends(require_same_origin)],
)
def save_profile(
    data: ProfileWrite, response: Response, user: CurrentUser, db: DbSession,
) -> UserProfile:
    """Create or fully replace the signed-in user's profile, with safe concurrent inserts."""
    values = data.model_dump()
    create = (
        insert(UserProfile)
        .values(user_id=user.id, **values)
        .on_conflict_do_nothing(index_elements=[UserProfile.user_id])
        .returning(UserProfile)
    )
    profile = db.scalar(create)
    if profile is None:
        replace = (
            update(UserProfile)
            .where(UserProfile.user_id == user.id)
            .values(**values, updated_at=func.now())
            .returning(UserProfile)
        )
        profile = db.execute(replace, execution_options={"populate_existing": True}).scalar_one()
    else:
        response.status_code = 201

    db.commit()
    return profile
