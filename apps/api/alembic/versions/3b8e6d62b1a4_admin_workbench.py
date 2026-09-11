"""add independent recording review state

Revision ID: 3b8e6d62b1a4
Revises: c56642d0e0b5
Create Date: 2026-09-11 14:40:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "3b8e6d62b1a4"
down_revision: Union[str, Sequence[str], None] = "c56642d0e0b5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("recording_attempts") as batch:
        batch.add_column(sa.Column("review_status", sa.String(length=20), nullable=False, server_default="pending"))
        batch.add_column(sa.Column("review_note", sa.Text(), nullable=True))
        batch.add_column(sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("reviewed_by", sa.String(length=36), nullable=True))
        batch.create_index("ix_recording_attempts_review_status", ["review_status"], unique=False)
        batch.create_index("ix_recording_attempts_reviewed_by", ["reviewed_by"], unique=False)
        batch.create_foreign_key("fk_recording_attempts_reviewed_by_admin_users", "admin_users", ["reviewed_by"], ["id"])

    bind = op.get_bind()
    attempts = sa.table(
        "recording_attempts",
        sa.column("id", sa.String()), sa.column("state", sa.String()),
        sa.column("duration_seconds", sa.Float()), sa.column("qc_status", sa.String()),
        sa.column("qc_metrics", sa.JSON()), sa.column("invite_id", sa.String()),
    )
    invites = sa.table("invites", sa.column("id", sa.String()), sa.column("study_id", sa.String()))
    studies = sa.table(
        "studies", sa.column("id", sa.String()),
        sa.column("min_seconds", sa.Integer()), sa.column("max_seconds", sa.Integer()),
    )
    quality_rows = bind.execute(
        sa.select(
            attempts.c.id, attempts.c.state, attempts.c.duration_seconds, attempts.c.qc_metrics,
            studies.c.min_seconds, studies.c.max_seconds,
        ).select_from(
            attempts.join(invites, invites.c.id == attempts.c.invite_id).join(studies, studies.c.id == invites.c.study_id)
        )
    ).mappings()
    for row in quality_rows:
        metrics = row["qc_metrics"] or {}
        if isinstance(metrics, str):
            import json
            metrics = json.loads(metrics)
        reasons: list[str] = []
        duration = row["duration_seconds"]
        if row["state"] == "failed":
            quality_status = "reject"
        elif duration is None:
            quality_status = "pending"
        else:
            if duration < row["min_seconds"]:
                reasons.append("录音短于任务要求")
            if duration > row["max_seconds"]:
                reasons.append("录音长于任务要求")
            mean_volume = metrics.get("mean_volume_db") if isinstance(metrics, dict) else None
            max_volume = metrics.get("max_volume_db") if isinstance(metrics, dict) else None
            if mean_volume is None or max_volume is None:
                reasons.append("缺少音量指标")
            else:
                if float(mean_volume) < -45:
                    reasons.append("平均音量过低")
                if float(max_volume) < -18:
                    reasons.append("峰值音量过低")
            quality_status = "review" if reasons else "pass"
        if isinstance(metrics, dict):
            metrics["quality_reasons"] = reasons
        bind.execute(
            attempts.update().where(attempts.c.id == row["id"]).values(qc_status=quality_status, qc_metrics=metrics)
        )

    events = bind.execute(sa.text(
        "SELECT subject_id, actor_id, payload, created_at FROM audit_events "
        "WHERE action = 'recording_qc_updated' ORDER BY created_at"
    )).mappings()
    latest: dict[str, dict[str, object]] = {}
    for event in events:
        latest[str(event["subject_id"])] = dict(event)
    for attempt_id, event in latest.items():
        payload = event.get("payload") or {}
        if isinstance(payload, str):
            import json
            payload = json.loads(payload)
        old_status = payload.get("status") if isinstance(payload, dict) else None
        review_status = "approved" if old_status == "pass" else "rejected" if old_status == "reject" else "pending"
        bind.execute(sa.text(
            "UPDATE recording_attempts SET review_status = :status, review_note = :note, "
            "reviewed_at = :reviewed_at, reviewed_by = :reviewed_by WHERE id = :attempt_id"
        ), {
            "status": review_status,
            "note": payload.get("note") if isinstance(payload, dict) else None,
            "reviewed_at": event.get("created_at"),
            "reviewed_by": event.get("actor_id"),
            "attempt_id": attempt_id,
        })


def downgrade() -> None:
    with op.batch_alter_table("recording_attempts") as batch:
        batch.drop_constraint("fk_recording_attempts_reviewed_by_admin_users", type_="foreignkey")
        batch.drop_index("ix_recording_attempts_reviewed_by")
        batch.drop_index("ix_recording_attempts_review_status")
        batch.drop_column("reviewed_by")
        batch.drop_column("reviewed_at")
        batch.drop_column("review_note")
        batch.drop_column("review_status")
