"""add auto_sweep_enabled and sweep_rules to profiles

The Profile model declares these two columns but no migration ever created
them, so any query against profiles failed with "no such column" on databases
built from the migration chain.

Revision ID: c4f1a8b02d17
Revises: 73e3beff3547
Create Date: 2026-09-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4f1a8b02d17'
down_revision: Union[str, Sequence[str], None] = '73e3beff3547'
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
    if not _has_column('profiles', 'auto_sweep_enabled'):
        op.add_column(
            'profiles',
            sa.Column('auto_sweep_enabled', sa.Boolean(), nullable=True,
                      server_default=sa.false()),
        )
    if not _has_column('profiles', 'sweep_rules'):
        op.add_column(
            'profiles',
            sa.Column('sweep_rules', sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    """Downgrade schema."""
    if _has_column('profiles', 'sweep_rules'):
        op.drop_column('profiles', 'sweep_rules')
    if _has_column('profiles', 'auto_sweep_enabled'):
        op.drop_column('profiles', 'auto_sweep_enabled')
