"""Store user profiles and weight goals.

Revision ID: 0003_user_profiles
Revises: 0002_auth_sessions
"""

from alembic import op
import sqlalchemy as sa

revision = "0003_user_profiles"
down_revision = "0002_auth_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_profiles",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("goal", sa.String(length=8), nullable=False),
        sa.Column("age", sa.Integer(), nullable=False),
        sa.Column("height_cm", sa.Float(precision=53), nullable=False),
        sa.Column("current_weight_kg", sa.Float(precision=53), nullable=False),
        sa.Column("gender", sa.String(length=24), nullable=False),
        sa.Column("activity_description", sa.Text(), nullable=False),
        sa.Column("gym_sessions_per_week", sa.Integer(), nullable=False),
        sa.Column("steps_per_day", sa.Integer(), nullable=False),
        sa.Column("target_weight_kg", sa.Float(precision=53), nullable=True),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("goal IN ('gain', 'lose', 'maintain')", name="ck_user_profiles_goal"),
        sa.CheckConstraint("age BETWEEN 18 AND 120", name="ck_user_profiles_age"),
        sa.CheckConstraint("height_cm BETWEEN 50 AND 300", name="ck_user_profiles_height"),
        sa.CheckConstraint("current_weight_kg BETWEEN 20 AND 500", name="ck_user_profiles_weight"),
        sa.CheckConstraint(
            "gender IN ('female', 'male', 'other', 'prefer_not_to_say')",
            name="ck_user_profiles_gender",
        ),
        sa.CheckConstraint(
            "char_length(btrim(activity_description)) BETWEEN 1 AND 2000",
            name="ck_user_profiles_activity",
        ),
        sa.CheckConstraint("gym_sessions_per_week BETWEEN 0 AND 21", name="ck_user_profiles_gym"),
        sa.CheckConstraint("steps_per_day BETWEEN 0 AND 100000", name="ck_user_profiles_steps"),
        sa.CheckConstraint(
            "target_weight_kg IS NULL OR target_weight_kg BETWEEN 20 AND 500",
            name="ck_user_profiles_target_weight",
        ),
        sa.CheckConstraint(
            "(goal = 'maintain' AND target_weight_kg IS NULL AND target_date IS NULL) OR "
            "(goal = 'gain' AND target_weight_kg IS NOT NULL AND target_date IS NOT NULL "
            "AND target_weight_kg > current_weight_kg) OR "
            "(goal = 'lose' AND target_weight_kg IS NOT NULL AND target_date IS NOT NULL "
            "AND target_weight_kg < current_weight_kg)",
            name="ck_user_profiles_goal_target",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("user_profiles")
