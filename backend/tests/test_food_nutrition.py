import pytest
from pydantic import ValidationError

from app.food_nutrition import FoodInterpretation, FoodNutrition

APPLE = {
    "name": "Medium apple", "serving_description": "One medium raw apple, skin included.",
    "estimated_weight_g": 182.0, "calories": 95,
    "protein_g": 0.5, "carbohydrate_g": 25.1, "fat_g": 0.3, "fiber_g": 4.4,
    "serving_assumptions": ["Assumed: one medium edible apple, about 182g."],
    "cooking_assumptions": ["Assumed: raw, with skin; no added fat."],
}


def test_food_result_rounds_grams_and_preserves_one_integer_calorie_value() -> None:
    food = FoodNutrition.model_validate({**APPLE, "protein_g": 0.543, "fat_g": 0.321})
    assert food.calories == 95 and type(food.calories) is int
    assert food.protein_g == 0.5 and food.fat_g == 0.3


def test_integral_json_numbers_are_normalized_without_accepting_fractional_calories() -> None:
    food = FoodNutrition.model_validate({**APPLE, "calories": 95.0})
    assert food.calories == 95 and type(food.calories) is int


@pytest.mark.parametrize("field,value", [
    ("calories", -1), ("calories", 20001), ("calories", "95"), ("calories", 95.5),
    ("calories", True), ("protein_g", -1), ("fat_g", float("nan")),
    ("carbohydrate_g", float("inf")), ("estimated_weight_g", 0),
    ("name", " "), ("serving_description", ""), ("serving_assumptions", []),
    ("cooking_assumptions", []), ("serving_assumptions", ["x"] * 7),
    ("cooking_assumptions", ["x" * 401]),
])
def test_invalid_or_missing_nutrition_values_are_rejected(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        FoodNutrition.model_validate({**APPLE, field: value})


def test_unknown_fields_cannot_add_unvalidated_calorie_totals() -> None:
    with pytest.raises(ValidationError):
        FoodNutrition.model_validate({**APPLE, "actual_calories": 100})


@pytest.mark.parametrize("change", [
    {"fiber_g": 30}, {"protein_g": 180}, {"calories": 2000},
])
def test_totals_obey_basic_mass_fiber_and_density_checks(change: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        FoodNutrition.model_validate({**APPLE, **change})


def test_water_is_a_valid_zero_calorie_drink() -> None:
    food = FoodNutrition.model_validate({
        **APPLE, "name": "Water", "estimated_weight_g": 250,
        "calories": 0, "protein_g": 0, "carbohydrate_g": 0, "fat_g": 0, "fiber_g": 0,
    })
    assert food.calories == 0


def test_valid_foods_are_not_forced_to_match_simple_macro_energy() -> None:
    # Calories may also reflect alcohol or food-specific fiber/polyol factors.
    wine = FoodNutrition.model_validate({
        **APPLE, "name": "Wine", "estimated_weight_g": 150,
        "calories": 125, "protein_g": 0.1, "carbohydrate_g": 3.8, "fat_g": 0, "fiber_g": 0,
    })
    assert wine.calories == 125


@pytest.mark.parametrize("recognized,food", [(True, None), (False, APPLE)])
def test_recognition_flag_must_match_the_nutrition_object(recognized: bool, food: object) -> None:
    with pytest.raises(ValidationError):
        FoodInterpretation.model_validate({"recognized": recognized, "food": food})


def test_unknown_food_is_distinct_from_a_zero_calorie_food() -> None:
    result = FoodInterpretation.model_validate({"recognized": False, "food": None})
    assert result.food is None and result.recognized is False
