"""add insight scheduling preferences and generated daily insights

Revision ID: b2e6f4a17c30
Revises: 825340264c0a
Create Date: 2026-09-13

Scope note
----------
This is everything the Overview's notification bell and Daily AI Insights
scheduling needed from the database, and nothing else.

Notifications required no change at all. `notifications` and
`notification_preferences` already exist (1863a55d8be8) with read/unread state,
per-user scoping and a preference row — the bell is a client for a store that
was already here.

What was missing was on the insights side. `profiles.insights_schedule`
(ec8170c8e88e) held a frequency, but the scheduler read it against a hard-coded
9am and never generated anything, so a user could not choose a time and nothing
was produced when one arrived. Hence:

  * `profiles.insights_enabled` — the dialog's on/off switch. A nullable column
    with a server default of true, so every existing profile keeps generating
    insights exactly as before without a backfill.
  * `profiles.insights_time` — 'HH:MM', 24-hour. Defaults to '09:00', which is
    the hour the old scheduler hard-coded, so existing users see no change in
    behaviour from this migration alone.
  * `daily_insights` — what the scheduler produced, one row per profile per
    day. Without somewhere to put the result, "generate at 08:00" has no
    observable meaning: GET /home recomputed the insight on every request.

`daily_insights` holds no credentials and no new class of personal data beyond
the insight text already returned by GET /home, but it is user data in a schema
whose Data API is deliberately shut (f1a9c3e7b204), so RLS is enabled on it to
match its neighbours. That migration's ALTER DEFAULT PRIVILEGES already keeps
`anon`/`authenticated` off tables created after it; this only closes the second
half of the same door. No existing table's RLS or grants are touched.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2e6f4a17c30'
down_revision: Union[str, Sequence[str], None] = '825340264c0a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Conditional on the table existing so this is safe to run against a database
# built before RLS was introduced, and a no-op on plain local PostgreSQL.
_ENABLE_RLS = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'daily_insights'
    ) THEN
        EXECUTE 'ALTER TABLE public.daily_insights ENABLE ROW LEVEL SECURITY';
    END IF;
END $$;
"""

_DISABLE_RLS = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'daily_insights'
    ) THEN
        EXECUTE 'ALTER TABLE public.daily_insights DISABLE ROW LEVEL SECURITY';
    END IF;
END $$;
"""


def upgrade() -> None:
    # server_default rather than a Python-side default: these columns are added
    # to a populated table, and existing rows have to come out true/'09:00'
    # rather than NULL or the scheduler would read every pre-existing profile
    # as "scheduling disabled".
    op.add_column(
        'profiles',
        sa.Column('insights_enabled', sa.Boolean(), nullable=True, server_default=sa.true()),
    )
    op.add_column(
        'profiles',
        sa.Column('insights_time', sa.String(), nullable=True, server_default='09:00'),
    )

    op.create_table(
        'daily_insights',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=False),
        sa.Column('generated_for', sa.Date(), nullable=False),
        sa.Column('payload', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('profile_id', 'generated_for', name='uq_daily_insight_profile_day'),
    )
    op.create_index(op.f('ix_daily_insights_id'), 'daily_insights', ['id'], unique=False)
    op.create_index(op.f('ix_daily_insights_profile_id'), 'daily_insights', ['profile_id'], unique=False)
    op.create_index(op.f('ix_daily_insights_generated_for'), 'daily_insights', ['generated_for'], unique=False)

    if op.get_bind().dialect.name == 'postgresql':
        op.execute(_ENABLE_RLS)


def downgrade() -> None:
    if op.get_bind().dialect.name == 'postgresql':
        op.execute(_DISABLE_RLS)

    op.drop_index(op.f('ix_daily_insights_generated_for'), table_name='daily_insights')
    op.drop_index(op.f('ix_daily_insights_profile_id'), table_name='daily_insights')
    op.drop_index(op.f('ix_daily_insights_id'), table_name='daily_insights')
    op.drop_table('daily_insights')

    op.drop_column('profiles', 'insights_time')
    op.drop_column('profiles', 'insights_enabled')
