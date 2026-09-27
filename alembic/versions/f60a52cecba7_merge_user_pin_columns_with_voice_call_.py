"""merge user pin columns with voice call logs

Revision ID: f60a52cecba7
Revises: a7f3c2d81e95, c5d8f1a4b209
Create Date: 2026-09-17 14:10:42.516540

Joins the two branches that both grew from b2e6f4a17c30:

  * c3d9e1f5a702 -> d8a2f6c41b93 -> e3b7c5a91d24 -> a7f3c2d81e95
    compliance filings, billing tiers, Kal Coins, voice_call_logs
  * c5d8f1a4b209
    users.pin_hash and users.pin_set_at

The branches touch different tables, so there is nothing to reconcile here and
both functions are empty.

On the shared Supabase database, which is stamped a7f3c2d81e95 and already has
both PIN columns, `alembic upgrade head` runs c5d8f1a4b209 (its column checks
find the columns present and add nothing) and then this revision, which only
moves the version stamp. No table is altered and no data is touched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f60a52cecba7'
down_revision: Union[str, Sequence[str], None] = ('a7f3c2d81e95', 'c5d8f1a4b209')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
