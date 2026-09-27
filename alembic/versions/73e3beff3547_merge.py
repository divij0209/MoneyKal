"""merge

Revision ID: 73e3beff3547
Revises: 275442d9fccc, a4b8d1c6e703
Create Date: 2026-09-03 12:39:44.433219

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '73e3beff3547'
down_revision: Union[str, Sequence[str], None] = ('275442d9fccc', 'a4b8d1c6e703')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
