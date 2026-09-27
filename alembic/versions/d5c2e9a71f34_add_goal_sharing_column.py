"""add shared_with_profile_ids to financial_goals

The FinancialGoal model declares this column and backend/routers/home.py both
reads and writes it, but no migration ever created it. Every request that
loaded a goal therefore failed with "no such column", which surfaced as a 500
on GET /home and an empty Daily Home in the client.

Revision ID: d5c2e9a71f34
Revises: c4f1a8b02d17
Create Date: 2026-09-06

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5c2e9a71f34'
down_revision: Union[str, Sequence[str], None] = 'c4f1a8b02d17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    """Whether the column is already present.

    Revision 9f43d189dd4c, on the branch this one was written in parallel with,
    adds the same column. Once the branches merged both landed in the same
    chain, so whichever runs second must do nothing rather than fail with
    "column already exists" and block the whole upgrade.
    """
    insp = sa.inspect(op.get_bind())
    if not insp.has_table(table):
        return False
    return column in {c["name"] for c in insp.get_columns(table)}



def upgrade() -> None:
    """Upgrade schema."""
    if not _has_column('financial_goals', 'shared_with_profile_ids'):
        op.add_column(
            'financial_goals',
            sa.Column('shared_with_profile_ids', sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    """Downgrade schema."""
    if _has_column('financial_goals', 'shared_with_profile_ids'):
        op.drop_column('financial_goals', 'shared_with_profile_ids')
