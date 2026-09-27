"""add compliance_filings for the Startup Compliance Center

Revision ID: c3d9e1f5a702
Revises: b2e6f4a17c30
Create Date: 2026-09-14

The Compliance Center computed deadlines but had nowhere to record that one had
been met, so any deadline after onboarding was reported as overdue forever,
with an accruing penalty, whether or not it had been filed. This table holds
what the founder tells it about each occurrence: filed (and when), not
applicable, or the amount due for the period so interest can be computed.

One row per profile per obligation per due date. `obligation_id` is a key into
backend/config/compliance_config.py rather than a foreign key, because the
obligations are configuration, not data.

The table holds user data in a schema whose Data API is shut (f1a9c3e7b204), so
RLS is enabled on it to match its neighbours. The create is guarded in case
DB_AUTO_CREATE built the table from the model first.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3d9e1f5a702'
down_revision: Union[str, Sequence[str], None] = 'b2e6f4a17c30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_ENABLE_RLS = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'compliance_filings'
    ) THEN
        EXECUTE 'ALTER TABLE public.compliance_filings ENABLE ROW LEVEL SECURITY';
    END IF;
END $$;
"""

_DISABLE_RLS = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'compliance_filings'
    ) THEN
        EXECUTE 'ALTER TABLE public.compliance_filings DISABLE ROW LEVEL SECURITY';
    END IF;
END $$;
"""


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if 'compliance_filings' not in inspector.get_table_names():
        op.create_table(
            'compliance_filings',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('profile_id', sa.Integer(), nullable=False),
            sa.Column('obligation_id', sa.String(), nullable=False),
            sa.Column('due_date', sa.Date(), nullable=False),
            sa.Column('status', sa.String(), nullable=False),
            sa.Column('filed_on', sa.Date(), nullable=True),
            sa.Column('amount', sa.Float(), nullable=True),
            sa.Column('note', sa.String(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('profile_id', 'obligation_id', 'due_date',
                                name='uq_compliance_filing_occurrence'),
        )
        op.create_index(op.f('ix_compliance_filings_id'), 'compliance_filings', ['id'], unique=False)
        op.create_index(op.f('ix_compliance_filings_profile_id'), 'compliance_filings', ['profile_id'],
                        unique=False)

    if _is_postgres():
        op.execute(_ENABLE_RLS)


def downgrade() -> None:
    if _is_postgres():
        op.execute(_DISABLE_RLS)
    op.drop_index(op.f('ix_compliance_filings_profile_id'), table_name='compliance_filings')
    op.drop_index(op.f('ix_compliance_filings_id'), table_name='compliance_filings')
    op.drop_table('compliance_filings')
