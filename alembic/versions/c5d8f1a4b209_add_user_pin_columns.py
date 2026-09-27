"""add pin_hash and pin_set_at to users

Revision ID: c5d8f1a4b209
Revises: b2e6f4a17c30
Create Date: 2026-09-16

Scope note
----------
Two nullable columns on `users`, and nothing else. This is the whole database
cost of the MoneyKal PIN.

WHY ON `users` AND NOT SOMEWHERE THAT NEEDS NO MIGRATION
--------------------------------------------------------
The obvious no-migration home was `Profile.raw_inputs`, the JSON column the
avatar already uses. It is not safe for a credential:

  * GET /profile/me returns raw_inputs verbatim to the browser. A bcrypt hash
    of a four-digit PIN handed to the client is ten thousand candidates, which
    is an offline crack, not a deterrent.
  * POST /onboard/confirm reassigns profile.raw_inputs wholesale, so re-running
    onboarding would silently delete the PIN.
  * It is profile-scoped, so an account that has not completed onboarding could
    not have a PIN at all.

A PIN is an authentication artefact and belongs next to the password hash.

WHY THIS IS SAFE TO APPLY
-------------------------
Both columns are nullable with no server default, so `ADD COLUMN` is a
metadata-only change on PostgreSQL 11+ — no table rewrite and no lock of any
consequence, on Supabase or anywhere else. Every existing row gets NULL, and a
NULL pin_hash is exactly what "this account has no PIN" means, so no backfill
is needed and no existing behaviour changes.

Nothing reads these columns except backend/routers/auth.py's PIN routes.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5d8f1a4b209'
down_revision: Union[str, Sequence[str], None] = 'b2e6f4a17c30'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _user_columns() -> set:
    """Guarded the same way ec8170c8e88e is: a database where these columns
    already exist (created by create_all, or by a half-applied run) must not
    wedge the whole chain on a duplicate-column error."""
    return {c['name'] for c in sa.inspect(op.get_bind()).get_columns('users')}


def upgrade() -> None:
    existing = _user_columns()
    if 'pin_hash' not in existing:
        op.add_column('users', sa.Column('pin_hash', sa.String(), nullable=True))
    if 'pin_set_at' not in existing:
        op.add_column('users', sa.Column('pin_set_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    existing = _user_columns()
    # Dropping these removes every PIN. Accounts fall back to password-only
    # sign-in, which is the behaviour before this revision — nothing is locked
    # out and nothing else depends on them.
    for name in ('pin_set_at', 'pin_hash'):
        if name in existing:
            op.drop_column('users', name)
