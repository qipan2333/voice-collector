"""One shared link per study; reset historical participation data.

Revision ID: a6c48d91f302
Revises: 7e902f5c81a2
"""
import secrets
from pathlib import Path

from alembic import op
import sqlalchemy as sa

from app.config import get_settings

revision = "a6c48d91f302"
down_revision = "7e902f5c81a2"
branch_labels = None
depends_on = None


def _remove_file(root: Path, relative: str | None) -> None:
    if not relative:
        return
    root = root.resolve()
    path = (root / relative).resolve()
    if path.is_relative_to(root) and path.is_file():
        path.unlink()


def upgrade() -> None:
    bind = op.get_bind()
    media_root = get_settings().media_root
    for row in bind.execute(sa.text("SELECT id, original_path, normalized_path FROM recording_attempts")).mappings():
        for relative in (row["original_path"], row["normalized_path"], f"incoming/{row['id']}.source"):
            _remove_file(media_root, relative)
    for path in bind.execute(sa.text("SELECT path FROM export_jobs")).scalars():
        _remove_file(media_root.parent, path)

    # Children must be removed before their parents, including queued worker jobs.
    for table in ("processing_jobs", "recording_attempts", "consent_receipts", "participant_sessions", "invites", "export_jobs", "audit_events"):
        op.execute(sa.text(f"DELETE FROM {table}"))
    with op.batch_alter_table("studies") as batch:
        batch.add_column(sa.Column("join_token", sa.String(64), nullable=True))
    studies = sa.table("studies", sa.column("id", sa.String()), sa.column("join_token", sa.String()))
    for study_id in bind.execute(sa.select(studies.c.id)).scalars():
        bind.execute(studies.update().where(studies.c.id == study_id).values(join_token=secrets.token_urlsafe(32)))
    with op.batch_alter_table("studies") as batch:
        batch.alter_column("join_token", existing_type=sa.String(64), nullable=False)
        batch.create_unique_constraint("uq_studies_join_token", ["join_token"])
    op.execute(sa.text("UPDATE studies SET status = 'draft', updated_at = CURRENT_TIMESTAMP"))


def downgrade() -> None:
    # Historical participation data cannot be restored by a schema downgrade.
    with op.batch_alter_table("studies") as batch:
        batch.drop_constraint("uq_studies_join_token", type_="unique")
        batch.drop_column("join_token")
