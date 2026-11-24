from datetime import UTC, date, datetime, timedelta

import pytest

from app.groq_client import ActivityInterpretation
from app.maintenance import MaintenanceEstimate
from app.nutrition import GoalProblem, calculate_plan, calorie_adjustment, nutrient_targets, suggest_date, validate_goal
from app.profiles import ProfileRead

TODAY = date(2026, 11, 23)
STAMP = datetime(2026, 11, 23, tzinfo=UTC)


def profile(goal: str = "maintain", days: int = 90, **fields: object) -> ProfileRead:
    values = dict(
        goal=goal, age=30, height_cm=175.5, current_weight_kg=75, gender="female",
        activity_description="Walking and gym.", gym_sessions_per_week=2, steps_per_day=6000,
        target_weight_kg=None if goal == "maintain" else (70 if goal == "lose" else 80),
        target_date=None if goal == "maintain" else TODAY + timedelta(days=days),
        created_at=STAMP, updated_at=STAMP,
    )
    return ProfileRead.model_validate({**values, **fields})


def estimate(calories: int = 2400) -> MaintenanceEstimate:
    return MaintenanceEstimate(
        resting_calories=1600, maintenance_calories=calories,
        activity=ActivityInterpretation(activity_level="moderate", summary="Regular activity.", assumptions=[]),
        activity_factor=1.55, formula_basis="female", assumptions=[], model="test-model",
        profile_updated_at=STAMP, estimated_at=STAMP,
    )


@pytest.mark.parametrize("goal,days,adjustment", [
    ("maintain", 90, 0), ("lose", 90, -427), ("gain", 120, 320),
])
def test_supported_goals_produce_signed_adjustments_and_balanced_targets(goal: str, days: int, adjustment: int) -> None:
    plan = calculate_plan(profile(goal, days), estimate(), TODAY)
    assert plan.targets.daily_calories == 2400 + adjustment
    assert plan.targets.calorie_adjustment == adjustment
    assert plan.timeline_days == (None if goal == "maintain" else days)
    assert plan.maintenance.maintenance_calories == 2400
    assert plan.targets.protein_g == 120
    assert abs(4 * plan.targets.protein_g + 4 * plan.targets.carbohydrate_g + 9 * plan.targets.fat_g - plan.targets.daily_calories) <= 1
    assert plan.targets.fiber_g >= 25
    if goal != "maintain":
        assert "cannot guarantee" in " ".join(plan.assumptions)


@pytest.mark.parametrize("days", [0, -1, 731])
def test_past_or_unsupported_dates_are_rejected(days: int) -> None:
    with pytest.raises(GoalProblem) as error:
        validate_goal(profile("lose", days), TODAY)
    assert error.value.detail["code"] == "goal_date"


@pytest.mark.parametrize("missing", ["target_date", "target_weight_kg"])
def test_legacy_incomplete_goal_is_rejected(missing: str) -> None:
    with pytest.raises(GoalProblem) as error:
        validate_goal(profile("lose", **{missing: None}), TODAY)
    assert error.value.detail["code"] == "goal_incomplete"


def test_underweight_loss_target_cannot_be_approved_by_a_long_deadline() -> None:
    with pytest.raises(GoalProblem) as error:
        validate_goal(profile("lose", 700, target_weight_kg=45), TODAY)
    assert error.value.detail["code"] == "target_too_low"
    assert error.value.detail["field"] == "target_weight_kg"


@pytest.mark.parametrize("goal,target", [("lose", 60), ("gain", 90)])
def test_fifteen_kilos_in_one_week_is_rejected_with_more_time_suggested(goal: str, target: int) -> None:
    with pytest.raises(GoalProblem) as error:
        validate_goal(profile(goal, 7, target_weight_kg=target), TODAY)
    assert error.value.detail["code"] == "timeline_too_short"
    assert date.fromisoformat(error.value.detail["suggested_target_date"]) > TODAY + timedelta(days=7)


def test_calorie_limit_can_require_a_longer_timeline_than_weekly_rate() -> None:
    with pytest.raises(GoalProblem) as error:
        calculate_plan(profile("lose", 60), estimate(1600), TODAY)
    assert error.value.detail["code"] == "calorie_adjustment_too_large"
    suggested = date.fromisoformat(error.value.detail["suggested_target_date"])
    changed = profile("lose", (suggested - TODAY).days)
    assert calculate_plan(changed, estimate(1600), TODAY).targets.daily_calories >= 1200


@pytest.mark.parametrize("gender,floor", [("female", 1200), ("male", 1500), ("other", 1500), ("prefer_not_to_say", 1500)])
def test_calorie_floors_are_enforced_for_all_gender_choices(gender: str, floor: int) -> None:
    with pytest.raises(GoalProblem) as error:
        calculate_plan(profile(gender=gender), estimate(floor - 1), TODAY)
    assert error.value.detail["code"] == "maintenance_too_low"
    assert calculate_plan(profile(gender=gender), estimate(floor), TODAY).targets.daily_calories == floor
    with pytest.raises(GoalProblem) as error:
        calculate_plan(profile("lose", gender=gender), estimate(floor), TODAY)
    assert error.value.detail["code"] == "no_calorie_room"


def test_rounding_never_increases_the_requested_deficit_or_surplus() -> None:
    for goal, days in [("gain", 120), ("lose", 90)]:
        saved = profile(goal, days)
        plan = calculate_plan(saved, estimate(), TODAY)
        exact = (saved.target_weight_kg - saved.current_weight_kg) * 7700 / days
        assert abs(plan.targets.calorie_adjustment) <= abs(exact)
        assert abs(plan.targets.calorie_adjustment) <= (1000 if goal == "lose" else 750)


def test_macro_energy_and_distribution_remain_consistent_across_supported_inputs() -> None:
    for calories in range(1200, 5001, 137):
        for weight in [20, 60, 75, 150, 500]:
            targets = nutrient_targets(calories, 0, weight)
            energy = 4 * targets.protein_g + 4 * targets.carbohydrate_g + 9 * targets.fat_g
            assert abs(energy - calories) <= 1
            assert 0.099 <= 4 * targets.protein_g / calories <= 0.251
            assert 0.449 <= 4 * targets.carbohydrate_g / calories <= 0.601
            assert 0.299 <= 9 * targets.fat_g / calories <= 0.301
            assert targets.fiber_g >= 25 and targets.fiber_g >= calories * 14 / 1000


def test_very_long_suggestions_do_not_overflow_dates() -> None:
    assert suggest_date(TODAY, 731) is None
    assert suggest_date(TODAY, 10.1) == TODAY + timedelta(days=11)


@pytest.mark.parametrize("weight", [50, 75, 100])
def test_two_kilos_gain_in_four_weeks_is_allowed_with_an_ambitious_pace_note(weight: int) -> None:
    saved = profile("gain", 28, current_weight_kg=weight, target_weight_kg=weight + 2)
    plan = calculate_plan(saved, estimate(1700), TODAY)
    assert plan.targets.calorie_adjustment == 550
    assert plan.targets.daily_calories == 2250
    assert plan.weekly_change_kg == 0.5
    assert plan.warnings and "ambitious gain" in plan.warnings[0]


def test_two_pounds_loss_per_week_is_allowed_when_intake_has_room() -> None:
    saved = profile("lose", 7, target_weight_kg=75 - 2 * 0.45359237)
    plan = calculate_plan(saved, estimate(2800), TODAY)
    assert plan.targets.calorie_adjustment == -997
    assert plan.targets.daily_calories == 1803
    assert plan.warnings and "ambitious loss" in plan.warnings[0]


@pytest.mark.parametrize("goal,target,days", [("lose", 73.9, 7), ("gain", 77, 27)])
def test_dates_above_the_new_weekly_limits_remain_blocked(goal: str, target: float, days: int) -> None:
    with pytest.raises(GoalProblem) as error:
        calculate_plan(profile(goal, days, target_weight_kg=target), estimate(2800), TODAY)
    assert error.value.detail["code"] == "timeline_too_short"
    suggested = date.fromisoformat(error.value.detail["suggested_target_date"])
    assert calculate_plan(profile(goal, (suggested - TODAY).days, target_weight_kg=target), estimate(2800), TODAY)


def test_a_faster_loss_goal_still_cannot_cross_the_daily_intake_floor() -> None:
    with pytest.raises(GoalProblem) as error:
        calculate_plan(profile("lose", 28, target_weight_kg=73), estimate(1700), TODAY)
    assert "1,200 kcal minimum" in error.value.detail["message"]
    suggestion = date.fromisoformat(error.value.detail["suggested_target_date"])
    plan = calculate_plan(profile("lose", (suggestion - TODAY).days, target_weight_kg=73), estimate(1700), TODAY)
    assert plan.targets.daily_calories >= 1200


@pytest.mark.parametrize("goal,target", [("lose", 60), ("gain", 90)])
def test_daily_adjustment_helper_defends_its_cap_even_if_a_caller_skips_rate_validation(goal: str, target: float) -> None:
    with pytest.raises(GoalProblem) as error:
        calorie_adjustment(profile(goal, 7, target_weight_kg=target), 4000, 7, TODAY)
    assert error.value.detail["code"] == "calorie_adjustment_too_large"


def test_maintain_and_gradual_plans_have_no_ambitious_pace_warning() -> None:
    assert calculate_plan(profile(), estimate(), TODAY).warnings == []
    assert calculate_plan(profile("gain", 90, target_weight_kg=76), estimate(), TODAY).warnings == []
    assert calculate_plan(profile("lose", 90, target_weight_kg=74), estimate(), TODAY).warnings == []
