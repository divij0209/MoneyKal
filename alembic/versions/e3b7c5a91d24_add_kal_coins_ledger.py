"""add Kal Coins: coin_transactions ledger, users.kal_coin_balance, users.created_at

Revision ID: e3b7c5a91d24
Revises: d8a2f6c41b93
Create Date: 2026-09-15

Plans & Billing, step 4. Additive only:

  * coin_transactions         — the Kal Coins ledger. Append-only; a unique
    idempotency_key stops any reward or redemption being recorded twice.
  * users.kal_coin_balance    — cached balance, NOT NULL with a server default
    of 0, so every existing account starts at zero without a backfill.
  * users.created_at          — when the account was created. Nullable and
    deliberately not backfilled: the real sign-up date of existing accounts is
    unknown. Kal Coins uses it to tell a friend who joined through an invite
    from someone who already had an account, and a NULL never qualifies.

The ledger holds user data in a schema whose Data API is shut (f1a9c3e7b204),
so RLS is enabled on it to match its neighbours.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e3b7c5a91d24'
down_revision: Union[str, Sequence[str], None] = 'd8a2f6c41b93'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _set_rls(enable: bool) -> str:
    action = 'ENABLE' if enable else 'DISABLE'
    return f"""
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'coin_transactions'
    ) THEN
        EXECUTE 'ALTER TABLE public.coin_transactions {action} ROW LEVEL SECURITY';
    END IF;
END $$;
"""


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    user_columns = {c['name'] for c in inspector.get_columns('users')}
    if 'kal_coin_balance' not in user_columns:
        op.add_column('users', sa.Column('kal_coin_balance', sa.Integer(), server_default='0', nullable=False))
    if 'created_at' not in user_columns:
        op.add_column('users', sa.Column('created_at', sa.DateTime(), nullable=True))

    if 'coin_transactions' not in inspector.get_table_names():
        op.create_table(
            'coin_transactions',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('user_id', sa.Integer(), nullable=False),
            sa.Column('type', sa.String(), nullable=False),
            sa.Column('reason', sa.String(), nullable=False),
            sa.Column('coins', sa.Integer(), nullable=False),
            sa.Column('balance_after', sa.Integer(), nullable=False),
            sa.Column('source_type', sa.String(), nullable=True),
            sa.Column('source_id', sa.Integer(), nullable=True),
            sa.Column('idempotency_key', sa.String(), nullable=False),
            sa.Column('meta', sa.JSON(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('idempotency_key'),
        )
        op.create_index(op.f('ix_coin_transactions_id'), 'coin_transactions', ['id'], unique=False)
        op.create_index('ix_coin_transactions_user_created', 'coin_transactions',
                        ['user_id', 'created_at'], unique=False)

    if _is_postgres():
        op.execute(_set_rls(True))


def downgrade() -> None:
    if _is_postgres():
        op.execute(_set_rls(False))
    op.drop_index('ix_coin_transactions_user_created', table_name='coin_transactions')
    op.drop_index(op.f('ix_coin_transactions_id'), table_name='coin_transactions')
    op.drop_table('coin_transactions')
    op.drop_column('users', 'created_at')
    op.drop_column('users', 'kal_coin_balance')
