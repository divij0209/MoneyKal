"""Add review state and source metadata to upcoming_payments

Revision ID: e2f6b8c4d031
Revises: d1e5a7b3c920
Create Date: 2026-08-27 00:00:00.000000

Additive only. Existing rows are backfilled to status='confirmed', which is the
behaviour they already had, so manually-added payments are unaffected.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e2f6b8c4d031'
down_revision: Union[str, Sequence[str], None] = 'd1e5a7b3c920'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('upcoming_payments', sa.Column('status', sa.String(), nullable=True))
    op.add_column('upcoming_payments', sa.Column('confidence', sa.Float(), nullable=True))
    op.add_column('upcoming_payments', sa.Column('source_ref', sa.String(), nullable=True))
    op.add_column('upcoming_payments', sa.Column('source_meta', sa.JSON(), nullable=True))
    op.create_index(op.f('ix_upcoming_payments_source_ref'), 'upcoming_payments', ['source_ref'], unique=False)

    # Every row that existed before detection was possible was user-entered and
    # already trusted — keep it that way.
    op.execute("UPDATE upcoming_payments SET status = 'confirmed' WHERE status IS NULL")


def downgrade() -> None:
    op.drop_index(op.f('ix_upcoming_payments_source_ref'), table_name='upcoming_payments')
    op.drop_column('upcoming_payments', 'source_meta')
    op.drop_column('upcoming_payments', 'source_ref')
    op.drop_column('upcoming_payments', 'confidence')
    op.drop_column('upcoming_payments', 'status')
