"""Store validated calorie and nutrient plans.

Revision ID: 0004_nutrition_plans
Revises: 0003_user_profiles
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004_nutrition_plans"
down_revision = "0003_user_profiles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "nutrition_plans",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("profile_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.CheckConstraint("jsonb_typeof(payload) = 'object'", name="ck_nutrition_plans_payload"),
        sa.ForeignKeyConstraint(["user_id"], ["user_profiles.user_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("nutrition_plans")
