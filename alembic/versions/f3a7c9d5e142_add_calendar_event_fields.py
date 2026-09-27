"""Add direction and event_type to upcoming_payments for the Financial Calendar

Revision ID: f3a7c9d5e142
Revises: e2f6b8c4d031
Create Date: 2026-08-28 00:00:00.000000

Additive only. Existing rows are backfilled to direction='out' — the meaning
they already had — and their event_type is inferred from the category they
were stored with, so nothing has to be re-detected.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f3a7c9d5e142'
down_revision: Union[str, Sequence[str], None] = 'e2f6b8c4d031'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('upcoming_payments', sa.Column('direction', sa.String(), nullable=True))
    op.add_column('upcoming_payments', sa.Column('event_type', sa.String(), nullable=True))

    # Every row that existed before this column was an outflow.
    op.execute("UPDATE upcoming_payments SET direction = 'out' WHERE direction IS NULL")

    # Best-effort classification from the category already on the row, so
    # existing bills and subscriptions get their calendar icon without a
    # re-scan of anyone's mailbox.
    op.execute("""
        UPDATE upcoming_payments SET event_type = CASE
            WHEN category = 'Subscriptions'     THEN 'subscription'
            WHEN category = 'Utilities & Bills' THEN 'bill'
            WHEN category = 'Rent / Housing'    THEN 'bill'
            WHEN category = 'Health & Medical'  THEN 'insurance'
            WHEN category = 'Taxes'             THEN 'tax'
            ELSE 'other'
        END
        WHERE event_type IS NULL
    """)


def downgrade() -> None:
    op.drop_column('upcoming_payments', 'event_type')
    op.drop_column('upcoming_payments', 'direction')
