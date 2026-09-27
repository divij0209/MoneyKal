"""add gst_profiles for the Startup GST Calculator

Revision ID: 825340264c0a
Revises: f1a9c3e7b204
Create Date: 2026-09-10 00:00:00.000000

Saved inputs for the GST Calculator, one row per profile per financial year.
Mirrors tax_profiles on the Individual side.

The create is guarded because backend/main.py calls Base.metadata.create_all()
at startup, which builds this table on any database that booted the app after
the model landed but before this migration ran.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '825340264c0a'
down_revision: Union[str, Sequence[str], None] = 'f1a9c3e7b204'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if 'gst_profiles' in inspector.get_table_names():
        return

    op.create_table(
        'gst_profiles',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('fy', sa.String(), nullable=False),
        sa.Column('inputs', sa.JSON(), nullable=True),
        sa.Column('last_result', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('profile_id', 'fy', name='uq_gst_profile_fy'),
    )
    op.create_index(op.f('ix_gst_profiles_id'), 'gst_profiles', ['id'], unique=False)
    op.create_index(op.f('ix_gst_profiles_profile_id'), 'gst_profiles', ['profile_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_gst_profiles_profile_id'), table_name='gst_profiles')
    op.drop_index(op.f('ix_gst_profiles_id'), table_name='gst_profiles')
    op.drop_table('gst_profiles')
