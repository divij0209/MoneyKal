"""merge multiple heads

Revision ID: 275442d9fccc
Revises: 8bfb32224221, f3a7c9d5e142
Create Date: 2026-09-01 22:12:23.685039

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '275442d9fccc'
down_revision: Union[str, Sequence[str], None] = ('8bfb32224221', 'f3a7c9d5e142')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
