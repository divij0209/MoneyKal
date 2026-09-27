"""bring voice_call_logs into the migration history and close two RLS gaps

Revision ID: a7f3c2d81e95
Revises: e3b7c5a91d24
Create Date: 2026-09-16

WHY THIS EXISTS
---------------
`VoiceCallLog` (backend/models/domain.py) shipped without a migration. On the
shared Supabase database the table nevertheless exists, because it was created
out of band — from the models, before auto_create_all and migrate.py were
taught to refuse remote targets. So the schema is right but Alembic has no
record of it, which is exactly the state that makes the next autogenerate do
something surprising. This revision adopts the table into the history.

It is written to be correct in both worlds:

  * Where the table is missing (a fresh database, a local SQLite file), it is
    created, matching the model exactly.
  * Where it already exists (Supabase today, 7 rows at the time of writing),
    the create is skipped and the existing rows are left completely untouched.

RLS
---
Two tables in `public` have row-level security off: `voice_call_logs` and
`gst_profiles`. Both were reached by f1a9c3e7b204's ALTER DEFAULT PRIVILEGES,
so `anon` and `authenticated` hold no grants on either and the Data API cannot
read them today. That is the outer lock; RLS is the inner one, and
f1a9c3e7b204 deliberately turns both. `voice_call_logs` holds phone numbers and
call transcripts and `gst_profiles` holds tax inputs, so both are enabled here.
Enabling RLS on a table whose owner is the connecting role changes nothing for
this backend: an owner bypasses RLS.

SAFETY
------
Additive only. No existing table is altered, no column is dropped or retyped,
no data is written, moved or deleted, and there is no backfill. Running it
twice is a no-op.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7f3c2d81e95'
down_revision: Union[str, Sequence[str], None] = 'e3b7c5a91d24'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _set_rls(table: str, enable: bool) -> str:
    """ALTER ... ROW LEVEL SECURITY, guarded so it is safe on any database.

    The IF EXISTS wrapper matters because this runs against databases where the
    table may legitimately not be there yet.
    """
    action = 'ENABLE' if enable else 'DISABLE'
    return f"""
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = '{table}'
    ) THEN
        EXECUTE 'ALTER TABLE public.{table} {action} ROW LEVEL SECURITY';
    END IF;
END $$;
"""


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if 'voice_call_logs' not in inspector.get_table_names():
        op.create_table(
            'voice_call_logs',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('profile_id', sa.Integer(), nullable=True),
            sa.Column('provider', sa.String(), nullable=True),
            sa.Column('session_id', sa.String(), nullable=True),
            sa.Column('call_type', sa.String(), nullable=True),
            sa.Column('phone_number', sa.String(), nullable=True),
            sa.Column('status', sa.String(), nullable=True),
            sa.Column('duration_seconds', sa.Integer(), nullable=True),
            sa.Column('summary', sa.Text(), nullable=True),
            sa.Column('transcript', sa.JSON(), nullable=True),
            sa.Column('ended_reason', sa.String(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
            sa.PrimaryKeyConstraint('id'),
        )

    # Indexes are created individually and only when missing, so this is also
    # correct on the database that already built the table from the models.
    existing = {ix['name'] for ix in inspector.get_indexes('voice_call_logs')} \
        if 'voice_call_logs' in inspector.get_table_names() else set()
    for name, cols in (
        ('ix_voice_call_logs_id', ['id']),
        ('ix_voice_call_logs_profile_id', ['profile_id']),
        ('ix_voice_call_logs_provider', ['provider']),
        ('ix_voice_call_logs_session_id', ['session_id']),
        ('ix_voice_call_logs_created_at', ['created_at']),
    ):
        if name not in existing:
            op.create_index(name, 'voice_call_logs', cols, unique=False)

    if _is_postgres():
        op.execute(_set_rls('voice_call_logs', True))
        # Same class of gap, closed in the same pass — see the module docstring.
        op.execute(_set_rls('gst_profiles', True))


def downgrade() -> None:
    """Reverses the RLS changes and drops the table.

    NOTE: on the shared database this table pre-dated the migration and holds
    real call logs. Downgrading past this revision therefore DELETES those
    rows. That is the honest inverse of "this revision owns the table", but it
    is worth knowing before running it.
    """
    if _is_postgres():
        op.execute(_set_rls('gst_profiles', False))
        op.execute(_set_rls('voice_call_logs', False))

    inspector = sa.inspect(op.get_bind())
    if 'voice_call_logs' not in inspector.get_table_names():
        return

    existing = {ix['name'] for ix in inspector.get_indexes('voice_call_logs')}
    for name in (
        'ix_voice_call_logs_created_at',
        'ix_voice_call_logs_session_id',
        'ix_voice_call_logs_provider',
        'ix_voice_call_logs_profile_id',
        'ix_voice_call_logs_id',
    ):
        if name in existing:
            op.drop_index(name, table_name='voice_call_logs')

    op.drop_table('voice_call_logs')
