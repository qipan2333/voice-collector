from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


JsonType = JSON().with_variant(JSONB, "postgresql")


class Study(Base):
    __tablename__ = "studies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(200), default="朗读录音任务")
    text: Mapped[str] = mapped_column(Text, default="请在这里配置固定朗读文本。")
    text_version: Mapped[str] = mapped_column(String(64), default="v1")
    instructions: Mapped[str] = mapped_column(Text, default="请在安静环境中使用手机完成录音。")
    status: Mapped[str] = mapped_column(String(20), default="draft", index=True)
    expected_seconds: Mapped[int] = mapped_column(Integer, default=180)
    min_seconds: Mapped[int] = mapped_column(Integer, default=30)
    max_seconds: Mapped[int] = mapped_column(Integer, default=480)
    consent_version: Mapped[str] = mapped_column(String(64), default="consent-v1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Invite(Base):
    __tablename__ = "invites"
    __table_args__ = (UniqueConstraint("study_id", "participant_code"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    study_id: Mapped[str] = mapped_column(ForeignKey("studies.id"), index=True)
    participant_code: Mapped[str] = mapped_column(String(32), index=True)
    token_digest: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(20), default="unused", index=True)
    first_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_access_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ParticipantSession(Base):
    __tablename__ = "participant_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    invite_id: Mapped[str] = mapped_column(ForeignKey("invites.id"), index=True)
    session_digest: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ConsentReceipt(Base):
    __tablename__ = "consent_receipts"
    __table_args__ = (UniqueConstraint("invite_id", "policy_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    invite_id: Mapped[str] = mapped_column(ForeignKey("invites.id"), index=True)
    policy_version: Mapped[str] = mapped_column(String(64))
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    confirmed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RecordingAttempt(Base):
    __tablename__ = "recording_attempts"
    __table_args__ = (UniqueConstraint("invite_id", "attempt_no"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    invite_id: Mapped[str] = mapped_column(ForeignKey("invites.id"), index=True)
    attempt_no: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(20), default="created", index=True)
    original_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    normalized_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    original_mime: Mapped[str | None] = mapped_column(String(120), nullable=True)
    original_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    original_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    normalized_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(nullable=True)
    client_duration_seconds: Mapped[float | None] = mapped_column(nullable=True)
    sample_rate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    channels: Mapped[int | None] = mapped_column(Integer, nullable=True)
    browser_family: Mapped[str | None] = mapped_column(String(100), nullable=True)
    os_family: Mapped[str | None] = mapped_column(String(100), nullable=True)
    recorder_settings: Mapped[dict[str, Any] | None] = mapped_column(JsonType, nullable=True)
    auto_quality_status: Mapped[str] = mapped_column("qc_status", String(20), default="pending", index=True)
    qc_metrics: Mapped[dict[str, Any] | None] = mapped_column(JsonType, nullable=True)
    review_status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    review_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(ForeignKey("admin_users.id"), nullable=True, index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    @property
    def qc_status(self) -> str:
        return self.auto_quality_status

    @qc_status.setter
    def qc_status(self, value: str) -> None:
        self.auto_quality_status = value


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    attempt_id: Mapped[str] = mapped_column(ForeignKey("recording_attempts.id"), unique=True, index=True)
    state: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    retries: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AdminUser(Base):
    __tablename__ = "admin_users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(300))
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AdminSession(Base):
    __tablename__ = "admin_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("admin_users.id"), index=True)
    session_digest: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    actor_type: Mapped[str] = mapped_column(String(30))
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(100), index=True)
    subject_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    subject_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    payload: Mapped[dict[str, Any] | None] = mapped_column(JsonType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ExportJob(Base):
    __tablename__ = "export_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    study_id: Mapped[str] = mapped_column(ForeignKey("studies.id"), index=True)
    variant: Mapped[str] = mapped_column(String(20), default="both")
    state: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
