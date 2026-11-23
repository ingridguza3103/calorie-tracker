from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import JSONB

from app.database import Base


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("username", name="uq_users_username"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )


class UserProfile(Base):
    __tablename__ = "user_profiles"
    __table_args__ = (
        CheckConstraint("goal IN ('gain', 'lose', 'maintain')", name="ck_user_profiles_goal"),
        CheckConstraint("age BETWEEN 18 AND 120", name="ck_user_profiles_age"),
        CheckConstraint("height_cm BETWEEN 50 AND 300", name="ck_user_profiles_height"),
        CheckConstraint("current_weight_kg BETWEEN 20 AND 500", name="ck_user_profiles_weight"),
        CheckConstraint(
            "gender IN ('female', 'male', 'other', 'prefer_not_to_say')",
            name="ck_user_profiles_gender",
        ),
        CheckConstraint(
            "char_length(btrim(activity_description)) BETWEEN 1 AND 2000",
            name="ck_user_profiles_activity",
        ),
        CheckConstraint(
            "gym_sessions_per_week BETWEEN 0 AND 21", name="ck_user_profiles_gym",
        ),
        CheckConstraint("steps_per_day BETWEEN 0 AND 100000", name="ck_user_profiles_steps"),
        CheckConstraint(
            "target_weight_kg IS NULL OR target_weight_kg BETWEEN 20 AND 500",
            name="ck_user_profiles_target_weight",
        ),
        CheckConstraint(
            "(goal = 'maintain' AND target_weight_kg IS NULL AND target_date IS NULL) OR "
            "(goal = 'gain' AND target_weight_kg IS NOT NULL AND target_date IS NOT NULL "
            "AND target_weight_kg > current_weight_kg) OR "
            "(goal = 'lose' AND target_weight_kg IS NOT NULL AND target_date IS NOT NULL "
            "AND target_weight_kg < current_weight_kg)",
            name="ck_user_profiles_goal_target",
        ),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True,
    )
    goal: Mapped[str] = mapped_column(String(8), nullable=False)
    age: Mapped[int] = mapped_column(nullable=False)
    height_cm: Mapped[float] = mapped_column(Float(53), nullable=False)
    current_weight_kg: Mapped[float] = mapped_column(Float(53), nullable=False)
    gender: Mapped[str] = mapped_column(String(24), nullable=False)
    activity_description: Mapped[str] = mapped_column(Text, nullable=False)
    gym_sessions_per_week: Mapped[int] = mapped_column(nullable=False)
    steps_per_day: Mapped[int] = mapped_column(nullable=False)
    target_weight_kg: Mapped[float | None] = mapped_column(Float(53), nullable=True)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False,
    )


class NutritionPlan(Base):
    __tablename__ = "nutrition_plans"
    __table_args__ = (
        CheckConstraint("jsonb_typeof(payload) = 'object'", name="ck_nutrition_plans_payload"),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("user_profiles.user_id", ondelete="CASCADE"), primary_key=True,
    )
    profile_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
