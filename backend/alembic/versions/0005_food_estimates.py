"""Store food nutrition estimates and their assumptions.

Revision ID: 0005_food_estimates
Revises: 0004_nutrition_plans
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0005_food_estimates"
down_revision = "0004_nutrition_plans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "food_estimates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("cache_key", sa.String(length=64), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("model", sa.String(length=200), nullable=False),
        sa.Column("estimated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("char_length(btrim(description)) BETWEEN 1 AND 2000", name="ck_food_estimates_description"),
        sa.CheckConstraint("jsonb_typeof(payload) = 'object'", name="ck_food_estimates_payload"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "cache_key", name="uq_food_estimates_user_cache"),
    )
    op.create_index("ix_food_estimates_user_id", "food_estimates", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_food_estimates_user_id", table_name="food_estimates")
    op.drop_table("food_estimates")
