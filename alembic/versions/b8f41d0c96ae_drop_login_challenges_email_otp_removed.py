"""drop login_challenges - the email OTP second factor was removed

Revision ID: b8f41d0c96ae
Revises: d4e9b1c73a58
Create Date: 2026-09-20

WHY THIS IS A NEW REVISION AND NOT A DELETED ONE
------------------------------------------------
d4e9b1c73a58 created `login_challenges` for the email OTP second factor, and it
was APPLIED to the production database. Deleting that file from the repository
would leave `alembic_version` in production holding a revision id that no
longer exists in the scripts directory, and the very next deploy would fail on:

    Can't locate revision identified by 'd4e9b1c73a58'

That failure would abort the pre-deploy step and block every subsequent
release, not just this one. So the original revision stays exactly where it is,
in history, and this revision reverses it going forward. `alembic_version`
moves on rather than backwards, which is the only direction Alembic is
comfortable being driven in an automated deploy.

The alternative — `alembic downgrade` against production — was deliberately not
used. It would have to run from somebody's laptop against the production
database, in a window where the deployed application and the schema disagree,
and it is not what the platform's pre-deploy step executes. A forward migration
applies through the same path as every other schema change.

WHY DROPPING IT IS SAFE
-----------------------
  * Nothing references it. It was the head, so no later revision builds on it,
    and the grep for its id across alembic/versions finds only itself.
  * No other table has a foreign key TO it. Its own FK points at `users`, which
    is untouched by dropping the child.
  * It holds no user data of any kind. A row is one in-flight sign-in attempt:
    a challenge id, a salt, a keyed digest, an attempt count and an expiry.
    Every row is worthless within five minutes of being written, and the
    application that created them no longer exists in this build.
  * `users` is not touched. d4e9b1c73a58 added no column to it, so there is
    nothing to unwind there.

WHAT THIS DOES NOT DO
---------------------
It does not touch any table it did not create. There is no data migration, no
backfill and no change to an existing column anywhere in this file.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8f41d0c96ae'
down_revision: Union[str, Sequence[str], None] = 'd4e9b1c73a58'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = 'login_challenges'


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    """Drop the table, if it is there.

    Guarded for the same reason every other migration in this directory is: a
    database that never got d4e9b1c73a58 — a fresh local checkout, a developer
    who rebuilt from scratch after the feature was removed — must not fail on a
    table that was never created.
    """
    inspector = sa.inspect(op.get_bind())
    if TABLE not in inspector.get_table_names():
        return

    # Indexes go first. PostgreSQL would drop them with the table anyway, but
    # being explicit keeps the downgrade below an exact mirror.
    for index in inspector.get_indexes(TABLE):
        name = index.get("name")
        if name:
            try:
                op.drop_index(name, table_name=TABLE)
            except Exception:  # noqa: BLE001 - an index already gone is not an error
                pass

    op.drop_table(TABLE)


def downgrade() -> None:
    """Recreate the table, empty.

    Reaching for this means putting the email OTP feature back, and the rows
    that were in it are gone for good — they were five-minute sign-in
    challenges, so there is nothing to restore and nothing that would still be
    valid if there were. The shape matches d4e9b1c73a58 exactly.
    """
    inspector = sa.inspect(op.get_bind())
    if TABLE in inspector.get_table_names():
        return

    op.create_table(
        TABLE,
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('challenge_id', sa.String(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('otp_salt', sa.String(), nullable=False),
        sa.Column('otp_hash', sa.String(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
        sa.Column('send_count', sa.Integer(), server_default='1', nullable=False),
        sa.Column('last_sent_at', sa.DateTime(), nullable=True),
        sa.Column('consumed_at', sa.DateTime(), nullable=True),
        sa.Column('remember_device', sa.Boolean(), server_default='0', nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_login_challenges_id'), TABLE, ['id'], unique=False)
    op.create_index(op.f('ix_login_challenges_challenge_id'), TABLE,
                    ['challenge_id'], unique=True)
    op.create_index(op.f('ix_login_challenges_user_id'), TABLE, ['user_id'], unique=False)
    op.create_index(op.f('ix_login_challenges_expires_at'), TABLE,
                    ['expires_at'], unique=False)
    op.create_index('ix_login_challenges_user_expires', TABLE,
                    ['user_id', 'expires_at'], unique=False)

    if _is_postgres():
        # f1a9c3e7b204 closed the Supabase Data API over this schema; a table
        # recreated here must not reopen it.
        op.execute(
            "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' "
            f"AND tablename='{TABLE}') THEN EXECUTE 'ALTER TABLE public.{TABLE} "
            "ENABLE ROW LEVEL SECURITY'; END IF; END $$;"
        )
