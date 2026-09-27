"""add login_challenges for mandatory email OTP two-factor authentication

Revision ID: d4e9b1c73a58
Revises: f60a52cecba7
Create Date: 2026-09-18

SCOPE
-----
One new table and nothing else. No existing table is altered, no column is
added to `users`, no data is read, written or moved. `alembic heads` before
this revision reported exactly one head, f60a52cecba7 (the merge of the PIN
columns with voice_call_logs), and this extends that single head — so the graph
still has one head after it and no merge revision is needed.

WHY A TABLE AND NOT COLUMNS ON `users`
--------------------------------------
A pending second factor is a property of one *sign-in attempt*, not of the
account. A person can have a challenge open in a browser and another on a
phone; columns on `users` would make those overwrite each other, and "your
previous code is no longer valid" would become indistinguishable from "someone
else is trying to sign in as you". Rows are also disposable — an expired
sign-in attempt has no business living in the account record forever, and
backend/services/twofa_service.py sweeps them.

WHAT IS STORED, AND WHAT IS NOT
-------------------------------
`otp_hash` is HMAC-SHA256 over `otp_salt` + the six-digit code, keyed with a
pepper derived from JWT_SECRET. The key is in the environment, not in this
database, so a dump of this table cannot be used to test even one candidate
code — which a plain SHA-256 of a six-digit value would allow in milliseconds.
The code itself is never written anywhere.

WHY THIS IS SAFE TO APPLY TO PRODUCTION
---------------------------------------
CREATE TABLE on a name that does not exist takes no lock on anything already
there and rewrites nothing. The table starts empty, and an empty
`login_challenges` is exactly the state "nobody is mid-sign-in", which is what
it means a second after any deploy anyway. Rolling the application back without
rolling this back leaves an unused table, which is harmless.

The create is guarded by an inspector check for the same reason ec8170c8e88e
and c5d8f1a4b209 are: a database where the table already exists — created by
DB_AUTO_CREATE on a local checkout, or by a half-applied run — must not wedge
the whole chain on a duplicate-table error.

ROW LEVEL SECURITY
------------------
f1a9c3e7b204 closed the Supabase Data API over this schema and altered default
privileges so new tables do not silently reopen it. RLS is still enabled here
explicitly, because `ALTER DEFAULT PRIVILEGES` governs grants and not RLS, and
this table holds a user id alongside an authentication secret. The backend
connects as the table owner, and an owner bypasses RLS, so this costs the
application nothing.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4e9b1c73a58'
down_revision: Union[str, Sequence[str], None] = 'f60a52cecba7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = 'login_challenges'


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _set_rls(enable: bool) -> str:
    action = 'ENABLE' if enable else 'DISABLE'
    return f"""
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = '{TABLE}'
    ) THEN
        EXECUTE 'ALTER TABLE public.{TABLE} {action} ROW LEVEL SECURITY';
    END IF;
END $$;
"""


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if TABLE not in inspector.get_table_names():
        op.create_table(
            TABLE,
            sa.Column('id', sa.Integer(), nullable=False),
            # The opaque public handle. 32 random bytes, URL-safe; the only
            # identifier a client ever sees.
            sa.Column('challenge_id', sa.String(), nullable=False),
            sa.Column('user_id', sa.Integer(), nullable=False),
            sa.Column('otp_salt', sa.String(), nullable=False),
            sa.Column('otp_hash', sa.String(), nullable=False),
            sa.Column('expires_at', sa.DateTime(), nullable=False),
            # Wrong codes against the CURRENT code. Reset by a resend.
            sa.Column('attempts', sa.Integer(), server_default='0', nullable=False),
            # Total codes this challenge has sent, the first included.
            sa.Column('send_count', sa.Integer(), server_default='1', nullable=False),
            sa.Column('last_sent_at', sa.DateTime(), nullable=True),
            # Non-NULL means spent: the code and the challenge are both dead.
            sa.Column('consumed_at', sa.DateTime(), nullable=True),
            # "Keep me signed in", decided with the password and carried here
            # because the device token is now minted at /auth/2fa/verify.
            sa.Column('remember_device', sa.Boolean(), server_default='0', nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index(op.f('ix_login_challenges_id'), TABLE, ['id'], unique=False)
        # Every verify and every resend is a lookup on exactly this column, and
        # it must be unique or one user could be handed another's challenge.
        op.create_index(op.f('ix_login_challenges_challenge_id'), TABLE,
                        ['challenge_id'], unique=True)
        op.create_index(op.f('ix_login_challenges_user_id'), TABLE, ['user_id'], unique=False)
        # The retention sweep filters on expires_at alone.
        op.create_index(op.f('ix_login_challenges_expires_at'), TABLE,
                        ['expires_at'], unique=False)
        # "Retire every challenge still open for this user" filters on the pair.
        op.create_index('ix_login_challenges_user_expires', TABLE,
                        ['user_id', 'expires_at'], unique=False)

    if _is_postgres():
        op.execute(_set_rls(True))


def downgrade() -> None:
    """Drops the table, and with it every challenge in flight.

    The practical effect is that anyone mid-sign-in at that moment has to start
    again from the password. Nothing else in the schema references this table,
    so nothing else is touched. It is only a sane thing to run alongside an
    application rollback to a build that does not require a second factor.
    """
    inspector = sa.inspect(op.get_bind())
    if TABLE not in inspector.get_table_names():
        return

    if _is_postgres():
        op.execute(_set_rls(False))

    for name in (
        'ix_login_challenges_user_expires',
        op.f('ix_login_challenges_expires_at'),
        op.f('ix_login_challenges_user_id'),
        op.f('ix_login_challenges_challenge_id'),
        op.f('ix_login_challenges_id'),
    ):
        try:
            op.drop_index(name, table_name=TABLE)
        except Exception:  # noqa: BLE001 — an index that isn't there is not an error
            pass

    op.drop_table(TABLE)
