"""add terms acceptance columns to users

Records which version of the Terms & Conditions a user accepted and when.
/auth/register writes it alongside the new account; /auth/login writes it too,
so accounts that predate this pick up a record on their next sign-in.

Existing rows get terms_accepted = false rather than a version nobody saw.

This revision also merges the two heads the graph had before it
(1dda7cd8831e and b4d7f2a91c53), so `alembic upgrade head` resolves again
without needing `heads`.

Revision ID: e7a4c1b90d26
Revises: 1dda7cd8831e, b4d7f2a91c53
Create Date: 2026-09-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e7a4c1b90d26'
down_revision: Union[str, Sequence[str], None] = ('1dda7cd8831e', 'b4d7f2a91c53')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_columns() -> set:
    return {c['name'] for c in sa.inspect(op.get_bind()).get_columns('users')}


def upgrade() -> None:
    """Upgrade schema.

    Written to be idempotent. This repository provisions schema two ways — the
    Alembic chain, and `create_all()` at startup and in migrate.py — so a
    developer can arrive here with the columns already present, and an
    `add_column` that assumed otherwise would fail the whole upgrade on a
    database that is in fact correct.
    """
    present = _existing_columns()

    # sa.false() compiles per dialect, so this is correct on both PostgreSQL
    # and the SQLite fallback in backend/database.py.
    if 'terms_accepted' not in present:
        op.add_column(
            'users',
            sa.Column('terms_accepted', sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if 'terms_version' not in present:
        op.add_column('users', sa.Column('terms_version', sa.String(), nullable=True))
    if 'terms_accepted_at' not in present:
        op.add_column('users', sa.Column('terms_accepted_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    present = _existing_columns()
    for name in ('terms_accepted_at', 'terms_version', 'terms_accepted'):
        if name in present:
            op.drop_column('users', name)
