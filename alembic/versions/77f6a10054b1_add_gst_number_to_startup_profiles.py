"""add gst_number to startup_profiles

Revision ID: 77f6a10054b1
Revises: 65e5f09943e9
Create Date: 2026-08-25 15:55:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '77f6a10054b1'
down_revision: Union[str, Sequence[str], None] = '65e5f09943e9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('startup_profiles', sa.Column('gst_number', sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('startup_profiles', 'gst_number')
