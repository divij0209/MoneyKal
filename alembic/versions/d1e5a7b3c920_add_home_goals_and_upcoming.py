"""Add financial_goals and upcoming_payments for the Daily Home dashboard

Revision ID: d1e5a7b3c920
Revises: 7d3d78c3ca00
Create Date: 2026-08-27 00:00:00.000000

Purely additive — no existing table or column is altered, so every existing
feature (What-If, Ask Twin, Hisaab, Startup reports) is unaffected.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd1e5a7b3c920'
down_revision: Union[str, Sequence[str], None] = '7d3d78c3ca00'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'financial_goals',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('name', sa.String(), nullable=True),
        sa.Column('icon', sa.String(), nullable=True),
        sa.Column('category', sa.String(), nullable=True),
        sa.Column('target_amount', sa.Float(), nullable=True),
        sa.Column('current_amount', sa.Float(), nullable=True),
        sa.Column('target_date', sa.Date(), nullable=True),
        sa.Column('is_primary', sa.Boolean(), nullable=True),
        sa.Column('status', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_financial_goals_id'), 'financial_goals', ['id'], unique=False)
    op.create_index(op.f('ix_financial_goals_profile_id'), 'financial_goals', ['profile_id'], unique=False)

    op.create_table(
        'upcoming_payments',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('name', sa.String(), nullable=True),
        sa.Column('amount', sa.Float(), nullable=True),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('category', sa.String(), nullable=True),
        sa.Column('recurrence', sa.String(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True),
        sa.Column('source', sa.String(), nullable=True),
        sa.Column('notes', sa.String(), nullable=True),
        sa.Column('last_paid_on', sa.Date(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_upcoming_payments_id'), 'upcoming_payments', ['id'], unique=False)
    op.create_index(op.f('ix_upcoming_payments_profile_id'), 'upcoming_payments', ['profile_id'], unique=False)
    op.create_index(op.f('ix_upcoming_payments_due_date'), 'upcoming_payments', ['due_date'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_upcoming_payments_due_date'), table_name='upcoming_payments')
    op.drop_index(op.f('ix_upcoming_payments_profile_id'), table_name='upcoming_payments')
    op.drop_index(op.f('ix_upcoming_payments_id'), table_name='upcoming_payments')
    op.drop_table('upcoming_payments')

    op.drop_index(op.f('ix_financial_goals_profile_id'), table_name='financial_goals')
    op.drop_index(op.f('ix_financial_goals_id'), table_name='financial_goals')
    op.drop_table('financial_goals')
