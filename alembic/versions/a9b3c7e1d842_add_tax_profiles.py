"""Add tax_profiles for the Individual Tax Calculator

Purely additive: one new table, no changes to any existing table. Dropping it
removes the feature's saved data and nothing else.

Revision ID: a9b3c7e1d842
Revises: f3a7c9d5e142
Create Date: 2026-08-30

"""
from alembic import op
import sqlalchemy as sa


revision = 'a9b3c7e1d842'
down_revision = 'f3a7c9d5e142'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'tax_profiles',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('tax_year', sa.String(), nullable=False),
        sa.Column('inputs', sa.JSON(), nullable=True),
        sa.Column('last_result', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('profile_id', 'tax_year', name='uq_tax_profile_year'),
    )
    op.create_index(op.f('ix_tax_profiles_id'), 'tax_profiles', ['id'], unique=False)
    op.create_index(op.f('ix_tax_profiles_profile_id'), 'tax_profiles', ['profile_id'], unique=False)


def downgrade():
    op.drop_index(op.f('ix_tax_profiles_profile_id'), table_name='tax_profiles')
    op.drop_index(op.f('ix_tax_profiles_id'), table_name='tax_profiles')
    op.drop_table('tax_profiles')
