"""Add chat_discovery_states for the Financial Discovery layer

Revision ID: a4b8d1c6e703
Revises: f3a7c9d5e142
Create Date: 2026-09-02 00:00:00.000000

Purely additive — one new table, no existing column altered. Sessions that
predate it simply have no row, and a missing row is the same as a fresh
conversation, so every existing chat keeps working exactly as it did.

The create is guarded because backend/main.py calls Base.metadata.create_all()
at startup, which builds this table on any database that booted the app before
this migration ran. Without the guard alembic dies on DuplicateTable there.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4b8d1c6e703'
down_revision: Union[str, Sequence[str], None] = 'f3a7c9d5e142'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if 'chat_discovery_states' in inspector.get_table_names():
        return

    op.create_table(
        'chat_discovery_states',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.String(), nullable=True),
        sa.Column('decision_type', sa.String(), nullable=True),
        sa.Column('user_intent', sa.String(), nullable=True),
        sa.Column('state', sa.JSON(), nullable=True),
        sa.Column('decision_context', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['session_id'], ['chat_sessions.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_chat_discovery_states_id'), 'chat_discovery_states', ['id'], unique=False)
    op.create_index(
        op.f('ix_chat_discovery_states_session_id'),
        'chat_discovery_states', ['session_id'], unique=True,
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_chat_discovery_states_session_id'), table_name='chat_discovery_states')
    op.drop_index(op.f('ix_chat_discovery_states_id'), table_name='chat_discovery_states')
    op.drop_table('chat_discovery_states')
