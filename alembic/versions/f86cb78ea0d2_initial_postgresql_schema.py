"""Initial PostgreSQL schema

Revision ID: f86cb78ea0d2
Revises: 
Create Date: 2026-08-13 15:50:13.085144

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f86cb78ea0d2'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('users',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('username', sa.String(), nullable=True),
        sa.Column('hashed_password', sa.String(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_users_id'), 'users', ['id'], unique=False)
    op.create_index(op.f('ix_users_username'), 'users', ['username'], unique=True)

    op.create_table('profiles',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('key', sa.String(), nullable=True),
        sa.Column('label', sa.String(), nullable=True),
        sa.Column('persona', sa.String(), nullable=True),
        sa.Column('currency', sa.String(), nullable=True),
        sa.Column('metrics', sa.JSON(), nullable=True),
        sa.Column('goal', sa.JSON(), nullable=True),
        sa.Column('decisionTypes', sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_profiles_id'), 'profiles', ['id'], unique=False)

    op.create_table('alerts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('level', sa.String(), nullable=True),
        sa.Column('text', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_alerts_id'), 'alerts', ['id'], unique=False)

    op.create_table('decision_history',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('title', sa.String(), nullable=True),
        sa.Column('date_str', sa.String(), nullable=True),
        sa.Column('outcome', sa.String(), nullable=True),
        sa.Column('tag', sa.String(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_decision_history_id'), 'decision_history', ['id'], unique=False)

    op.create_table('audit_traces',
        sa.Column('id', sa.String(), nullable=False),
        sa.Column('profile_id', sa.Integer(), nullable=True),
        sa.Column('timestamp', sa.DateTime(), nullable=True),
        sa.Column('query', sa.String(), nullable=True),
        sa.Column('response', sa.JSON(), nullable=True),
        sa.Column('reasoning_trace', sa.JSON(), nullable=True),
        sa.Column('sources', sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(['profile_id'], ['profiles.id'], ),
        sa.PrimaryKeyConstraint('id')
    )

    op.create_table('market_data',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('symbol', sa.String(), nullable=True),
        sa.Column('asset_type', sa.String(), nullable=True),
        sa.Column('price', sa.Float(), nullable=True),
        sa.Column('timestamp', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_market_data_id'), 'market_data', ['id'], unique=False)
    op.create_index(op.f('ix_market_data_symbol'), 'market_data', ['symbol'], unique=False)

    op.create_table('news_items',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('headline', sa.String(), nullable=True),
        sa.Column('summary', sa.String(), nullable=True),
        sa.Column('sentiment', sa.String(), nullable=True),
        sa.Column('category', sa.String(), nullable=True),
        sa.Column('timestamp', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_news_items_id'), 'news_items', ['id'], unique=False)

    op.create_table('economic_indicators',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('indicator_name', sa.String(), nullable=True),
        sa.Column('value', sa.Float(), nullable=True),
        sa.Column('timestamp', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_economic_indicators_id'), 'economic_indicators', ['id'], unique=False)
    op.create_index(op.f('ix_economic_indicators_indicator_name'), 'economic_indicators', ['indicator_name'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('economic_indicators')
    op.drop_table('news_items')
    op.drop_table('market_data')
    op.drop_table('audit_traces')
    op.drop_table('decision_history')
    op.drop_table('alerts')
    op.drop_table('profiles')
    op.drop_table('users')
