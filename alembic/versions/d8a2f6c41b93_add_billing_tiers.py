"""add billing tiers: orders, service entitlements, usage counters

Revision ID: d8a2f6c41b93
Revises: c3d9e1f5a702
Create Date: 2026-09-15

Plans & Billing, step 1. Additive only:

  * subscriptions.billing_cycle  — which ACT pass (monthly | yearly) the current
    period came from. Nullable; every existing row keeps working as before.
  * billing_orders               — one checkout for an ACT pass or a service.
  * service_entitlements         — a paid right to a pay-per-use service for one
    subject (the Tax Calculator for one tax year).
  * usage_counters               — free-tier monthly allowances used.

The tier itself is not a new column. It is derived from `subscriptions`, which
already decides premium access for Money Splits, so there is a single source of
truth for what a user is on.

New tables hold user data in a schema whose Data API is shut (f1a9c3e7b204), so
RLS is enabled on them to match their neighbours. Creates are guarded in case
DB_AUTO_CREATE built a table from the model first.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd8a2f6c41b93'
down_revision: Union[str, Sequence[str], None] = 'c3d9e1f5a702'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_NEW_TABLES = ('billing_orders', 'service_entitlements', 'usage_counters')


def _set_rls(table: str, enable: bool) -> str:
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


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = inspector.get_table_names()

    sub_columns = {c['name'] for c in inspector.get_columns('subscriptions')}
    if 'billing_cycle' not in sub_columns:
        op.add_column('subscriptions', sa.Column('billing_cycle', sa.String(), nullable=True))

    if 'billing_orders' not in tables:
        op.create_table(
            'billing_orders',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('user_id', sa.Integer(), nullable=False),
            sa.Column('sku', sa.String(), nullable=False),
            sa.Column('kind', sa.String(), nullable=False),
            sa.Column('subject_ref', sa.String(), nullable=True),
            sa.Column('gross_minor', sa.Integer(), nullable=False),
            sa.Column('coins_redeemed', sa.Integer(), server_default='0', nullable=False),
            sa.Column('coin_discount_minor', sa.Integer(), server_default='0', nullable=False),
            sa.Column('payable_minor', sa.Integer(), nullable=False),
            sa.Column('currency', sa.String(), server_default='INR', nullable=False),
            sa.Column('status', sa.String(), server_default='created', nullable=False),
            sa.Column('payment_mode', sa.String(), server_default='demo', nullable=False),
            sa.Column('payment_method', sa.String(), nullable=True),
            sa.Column('gateway_order_id', sa.String(), nullable=True),
            sa.Column('gateway_payment_id', sa.String(), nullable=True),
            sa.Column('meta', sa.JSON(), nullable=True),
            sa.Column('paid_at', sa.DateTime(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('gateway_order_id'),
        )
        op.create_index(op.f('ix_billing_orders_id'), 'billing_orders', ['id'], unique=False)
        op.create_index(op.f('ix_billing_orders_user_id'), 'billing_orders', ['user_id'], unique=False)

    if 'service_entitlements' not in tables:
        op.create_table(
            'service_entitlements',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('user_id', sa.Integer(), nullable=False),
            sa.Column('sku', sa.String(), nullable=False),
            sa.Column('subject_ref', sa.String(), nullable=False),
            sa.Column('order_id', sa.Integer(), nullable=True),
            sa.Column('status', sa.String(), server_default='active', nullable=False),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
            sa.ForeignKeyConstraint(['order_id'], ['billing_orders.id'], ),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('user_id', 'sku', 'subject_ref', name='uq_service_entitlement_subject'),
        )
        op.create_index(op.f('ix_service_entitlements_id'), 'service_entitlements', ['id'], unique=False)
        op.create_index(op.f('ix_service_entitlements_user_id'), 'service_entitlements', ['user_id'],
                        unique=False)

    if 'usage_counters' not in tables:
        op.create_table(
            'usage_counters',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('user_id', sa.Integer(), nullable=False),
            sa.Column('feature_key', sa.String(), nullable=False),
            sa.Column('period', sa.String(), nullable=False),
            sa.Column('count', sa.Integer(), server_default='0', nullable=False),
            sa.Column('updated_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('user_id', 'feature_key', 'period', name='uq_usage_counter_period'),
        )
        op.create_index(op.f('ix_usage_counters_id'), 'usage_counters', ['id'], unique=False)
        op.create_index(op.f('ix_usage_counters_user_id'), 'usage_counters', ['user_id'], unique=False)

    if _is_postgres():
        for table in _NEW_TABLES:
            op.execute(_set_rls(table, True))


def downgrade() -> None:
    if _is_postgres():
        for table in _NEW_TABLES:
            op.execute(_set_rls(table, False))

    op.drop_index(op.f('ix_usage_counters_user_id'), table_name='usage_counters')
    op.drop_index(op.f('ix_usage_counters_id'), table_name='usage_counters')
    op.drop_table('usage_counters')

    op.drop_index(op.f('ix_service_entitlements_user_id'), table_name='service_entitlements')
    op.drop_index(op.f('ix_service_entitlements_id'), table_name='service_entitlements')
    op.drop_table('service_entitlements')

    op.drop_index(op.f('ix_billing_orders_user_id'), table_name='billing_orders')
    op.drop_index(op.f('ix_billing_orders_id'), table_name='billing_orders')
    op.drop_table('billing_orders')

    op.drop_column('subscriptions', 'billing_cycle')
