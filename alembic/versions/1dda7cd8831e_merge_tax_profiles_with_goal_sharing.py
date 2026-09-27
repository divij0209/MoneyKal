"""merge tax profiles with goal sharing

Revision ID: 1dda7cd8831e
Revises: a9b3c7e1d842, d5c2e9a71f34
Create Date: 2026-09-06 17:53:51.648728

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1dda7cd8831e'
down_revision: Union[str, Sequence[str], None] = ('a9b3c7e1d842', 'd5c2e9a71f34')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
