"""Deterministic starting targets and conservative limits for automatic plans."""

import math
from datetime import date, timedelta
from typing import Literal

from pydantic import BaseModel, Field

from app.maintenance import MaintenanceEstimate
from app.profiles import ProfileRead

ENERGY_PER_KG = 7700
MAX_TIMELINE_DAYS = 730


class GoalProblem(Exception):
    def __init__(
        self, code: str, message: str, field: str = "target_date",
        suggested_target_date: date | None = None,
    ) -> None:
        super().__init__(message)
        self.detail = {
            "code": code, "message": message, "field": field,
            "suggested_target_date": suggested_target_date.isoformat() if suggested_target_date else None,
        }


class NutrientTargets(BaseModel):
    daily_calories: int = Field(gt=0)
    calorie_adjustment: int
    protein_g: float = Field(gt=0)
    carbohydrate_g: float = Field(gt=0)
    fat_g: float = Field(gt=0)
    fiber_g: int = Field(gt=0)


class CaloriePlan(BaseModel):
    version: Literal[1] = 1
    goal: Literal["gain", "lose", "maintain"]
    current_weight_kg: float
    target_weight_kg: float | None
    target_date: date | None
    timeline_days: int | None
    weekly_change_kg: float
    maintenance: MaintenanceEstimate
    targets: NutrientTargets
    assumptions: list[str]


def suggest_date(today: date, days: float) -> date | None:
    minimum = math.ceil(days)
    return today + timedelta(days=minimum) if minimum <= MAX_TIMELINE_DAYS else None


def validate_goal(profile: ProfileRead, today: date) -> int | None:
    if profile.goal == "maintain":
        return None
    # The profile schema already enforces direction and requires both fields.
    if profile.target_date is None or profile.target_weight_kg is None:
        raise GoalProblem("goal_incomplete", "Add a target weight and date to your profile.")
    days = (profile.target_date - today).days
    if not 1 <= days <= MAX_TIMELINE_DAYS:
        raise GoalProblem("goal_date", "Choose a future date within two years, or a smaller intermediate goal.")
    target_bmi = profile.target_weight_kg / (profile.height_cm / 100) ** 2
    if profile.goal == "lose" and target_bmi < 18.5:
        raise GoalProblem(
            "target_too_low", "This target weight is below the automatic planner's BMI limit of 18.5. Choose a higher target.",
            field="target_weight_kg",
        )
    change = abs(profile.target_weight_kg - profile.current_weight_kg)
    weekly_limit = (
        min(0.9, profile.current_weight_kg * 0.01) if profile.goal == "lose"
        else min(0.5, profile.current_weight_kg * 0.005)
    )
    if change * 7 / days > weekly_limit + 1e-9:
        raise GoalProblem(
            "timeline_too_short", "This goal needs more time. Extend the date or choose a smaller weight change.",
            suggested_target_date=suggest_date(today, change * 7 / weekly_limit),
        )
    return days


def calorie_adjustment(profile: ProfileRead, maintenance: int, days: int | None, today: date) -> int:
    floor = 1200 if profile.gender == "female" else 1500
    if maintenance < floor:
        raise GoalProblem(
            "maintenance_too_low", "Your estimated maintenance is below the automatic planner's calorie limit. Review your body and activity details.",
            field="profile",
        )
    if days is None:
        return 0
    change = profile.target_weight_kg - profile.current_weight_kg
    required = abs(change) * ENERGY_PER_KG / days
    limit = min(500, maintenance * 0.20)
    if profile.goal == "lose":
        limit = min(limit, maintenance - floor)
    if limit < 1:
        raise GoalProblem(
            "no_calorie_room", "This maintenance estimate leaves no room for an automatic deficit. Review your profile or choose maintain weight.",
            field="profile",
        )
    if required > limit + 1e-9:
        raise GoalProblem(
            "calorie_adjustment_too_large", "This date requires a daily calorie change beyond the automatic planner's limits. Extend the date or choose a smaller change.",
            suggested_target_date=suggest_date(today, abs(change) * ENERGY_PER_KG / limit),
        )
    # Round toward maintenance so rounding never increases the deficit/surplus.
    return math.trunc(change * ENERGY_PER_KG / days)


def nutrient_targets(calories: int, adjustment: int, weight: float) -> NutrientTargets:
    protein = max(calories * 0.10 / 4, min(weight * 1.6, calories * 0.25 / 4))
    fat = calories * 0.30 / 9
    carbohydrate = (calories - protein * 4 - fat * 9) / 4
    return NutrientTargets(
        daily_calories=calories, calorie_adjustment=adjustment,
        protein_g=round(protein, 1), carbohydrate_g=round(carbohydrate, 1),
        fat_g=round(fat, 1), fiber_g=max(25, math.ceil(calories * 14 / 1000)),
    )


def calculate_plan(profile: ProfileRead, estimate: MaintenanceEstimate, today: date) -> CaloriePlan:
    days = validate_goal(profile, today)
    adjustment = calorie_adjustment(profile, estimate.maintenance_calories, days, today)
    assumptions = [
        "These are starting estimates. Review your plan as your weight and routine change.",
        "Protein starts at 1.6 g/kg, within 10-25% of calories. Fat uses 30%; carbohydrates use the remainder.",
        "Fiber uses 14 g per 1,000 kcal, with a 25 g minimum. Rounded macro grams may differ slightly from total calories.",
    ]
    if days is not None:
        assumptions.append(
            "The date calculation uses a simplified 7,700 kcal/kg model at your current weight; it cannot guarantee a target date or muscle gain."
        )
    return CaloriePlan(
        goal=profile.goal, current_weight_kg=profile.current_weight_kg,
        target_weight_kg=profile.target_weight_kg, target_date=profile.target_date,
        timeline_days=days, weekly_change_kg=round(adjustment * 7 / ENERGY_PER_KG, 3),
        maintenance=estimate,
        targets=nutrient_targets(estimate.maintenance_calories + adjustment, adjustment, profile.current_weight_kg),
        assumptions=assumptions,
    )
