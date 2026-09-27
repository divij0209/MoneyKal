"""add_raw_inputs_to_profiles

Revision ID: 7d3d78c3ca00
Revises: 77f6a10054b1
Create Date: 2026-08-26 13:42:52.407483

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7d3d78c3ca00'
down_revision: Union[str, Sequence[str], None] = '77f6a10054b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('profiles', sa.Column('raw_inputs', sa.JSON().with_variant(sa.Text(), 'sqlite'), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('profiles', 'raw_inputs')
