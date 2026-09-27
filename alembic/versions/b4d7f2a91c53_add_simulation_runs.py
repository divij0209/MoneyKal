"""Add simulation_runs

Keeps every completed scenario simulation against the profile that ran it, so
the Simulate tab can list past runs and reopen any of them. `result` holds the
whole ScenarioSimulateResponse; the scalar columns beside it are denormalised
copies used to build the history list without loading the payloads.

Revision ID: b4d7f2a91c53
Revises: ec8170c8e88e
Create Date: 2026-09-07 19:55:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b4d7f2a91c53'
down_revision: Union[str, Sequence[str], None] = 'ec8170c8e88e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'simulation_runs',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('scenario', sa.Text(), nullable=True),
        sa.Column('scenario_type', sa.String(), nullable=True),
        sa.Column('mode', sa.String(), nullable=True),
        sa.Column('headline', sa.String(), nullable=True),
        sa.Column('result', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_simulation_runs_id'), 'simulation_runs', ['id'], unique=False)
    op.create_index(op.f('ix_simulation_runs_profile_id'), 'simulation_runs', ['profile_id'], unique=False)
    # The history list is "this profile's runs, newest first" — one composite
    # index serves that ordering directly.
    op.create_index(
        'ix_simulation_runs_profile_created',
        'simulation_runs',
        ['profile_id', 'created_at'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_simulation_runs_profile_created', table_name='simulation_runs')
    op.drop_index(op.f('ix_simulation_runs_profile_id'), table_name='simulation_runs')
    op.drop_index(op.f('ix_simulation_runs_id'), table_name='simulation_runs')
    op.drop_table('simulation_runs')
