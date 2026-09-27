"""add enterprise profiles

Revision ID: 65e5f09943e9
Revises: 54c4d08832d8
Create Date: 2026-08-25 15:52:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '65e5f09943e9'
down_revision: Union[str, Sequence[str], None] = '54c4d08832d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('enterprise_profiles',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('profile_id', sa.Integer(), nullable=True),
    sa.Column('cfo_name', sa.String(), nullable=True),
    sa.Column('corporate_email', sa.String(), nullable=True),
    sa.Column('corporate_mobile', sa.String(), nullable=True),
    sa.Column('org_name', sa.String(), nullable=True),
    sa.Column('industry', sa.String(), nullable=True),
    sa.Column('headcount', sa.Integer(), nullable=True),
    sa.Column('gst_number', sa.String(), nullable=True),
    sa.Column('treasury_balance', sa.Float(), nullable=True),
    sa.Column('annual_turnover', sa.Float(), nullable=True),
    sa.Column('quarterly_cash_flow', sa.Float(), nullable=True),
    sa.Column('operating_expenses', sa.Float(), nullable=True),
    sa.Column('fx_exposure_pct', sa.Float(), nullable=True),
    sa.Column('currently_fundraising', sa.Boolean(), nullable=True),
    sa.Column('debt_amount', sa.Float(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_enterprise_profiles_id'), 'enterprise_profiles', ['id'], unique=False)
    op.create_index(op.f('ix_enterprise_profiles_profile_id'), 'enterprise_profiles', ['profile_id'], unique=True)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_enterprise_profiles_profile_id'), table_name='enterprise_profiles')
    op.drop_index(op.f('ix_enterprise_profiles_id'), table_name='enterprise_profiles')
    op.drop_table('enterprise_profiles')
