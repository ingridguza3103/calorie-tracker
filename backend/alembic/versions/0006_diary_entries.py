"""Store dated food diary entries and retry-safe save identifiers.

Revision ID: 0006_diary_entries
Revises: 0005_food_estimates
"""

from alembic import op
import sqlalchemy as sa

revision = "0006_diary_entries"
down_revision = "0005_food_estimates"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_food_estimates_id_user", "food_estimates", ["id", "user_id"])
    op.create_table(
        "diary_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("food_estimate_id", sa.Integer(), nullable=False),
        sa.Column("entry_date", sa.Date(), nullable=False),
        sa.Column("servings", sa.Numeric(5, 2), nullable=False),
        sa.Column("request_fingerprint", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("servings BETWEEN 0.01 AND 20", name="ck_diary_entries_servings"),
        sa.CheckConstraint("version >= 1", name="ck_diary_entries_version"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["food_estimate_id", "user_id"], ["food_estimates.id", "food_estimates.user_id"],
            name="fk_diary_entries_estimate_owner", ondelete="NO ACTION",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_diary_entries_user_date", "diary_entries", ["user_id", "entry_date"])


def downgrade() -> None:
    op.drop_index("ix_diary_entries_user_date", table_name="diary_entries")
    op.drop_table("diary_entries")
    op.drop_constraint("uq_food_estimates_id_user", "food_estimates", type_="unique")
