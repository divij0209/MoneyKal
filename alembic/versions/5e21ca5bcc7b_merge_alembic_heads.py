"""Merge alembic heads

Revision ID: 5e21ca5bcc7b
Revises: 9f43d189dd4c, a9b3c7e1d842
Create Date: 2026-09-05 14:49:07.102643

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5e21ca5bcc7b'
down_revision: Union[str, Sequence[str], None] = ('9f43d189dd4c', 'a9b3c7e1d842')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
