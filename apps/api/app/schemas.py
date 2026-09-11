from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ErrorResponse(BaseModel):
    code: str
    message: str
    request_id: str | None = None


class ExchangeRequest(BaseModel):
    token: str = Field(min_length=16, max_length=300)


class ConsentRequest(BaseModel):
    confirmed: bool
    policy_version: str = Field(min_length=1, max_length=64)


class AttemptCreateRequest(BaseModel):
    client_duration_seconds: float | None = Field(default=None, ge=0, le=900)
    browser_family: str | None = Field(default=None, max_length=512)
    os_family: str | None = Field(default=None, max_length=256)
    recorder_settings: dict[str, Any] | None = None


class StudyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    text: str
    text_version: str
    instructions: str
    status: str
    expected_seconds: int
    min_seconds: int
    max_seconds: int
    consent_version: str
    created_at: datetime
    updated_at: datetime


class AttemptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    attempt_no: int
    state: str
    qc_status: str
    auto_quality_status: str
    review_status: str = "pending"
    review_note: str | None = None
    reviewed_at: datetime | None = None
    original_mime: str | None = None
    original_size: int | None = None
    duration_seconds: float | None = None
    client_duration_seconds: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    qc_metrics: dict[str, Any] | None = None
    error_message: str | None = None
    created_at: datetime
    submitted_at: datetime | None = None


class ParticipantContext(BaseModel):
    participant_code: str
    study: StudyOut
    consent_confirmed: bool
    follow_along_enabled: bool = False
    follow_along_interval_seconds: float = 8.0
    attempts: list[AttemptOut]


class BulkInviteRequest(BaseModel):
    study_id: str
    count: int = Field(default=100, ge=1, le=1000)


class InviteOut(BaseModel):
    id: str
    participant_code: str
    status: str
    url: str


class AdminLoginRequest(BaseModel):
    username: str
    password: str
    otp: str | None = None


class StudyCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1)
    instructions: str = Field(default="请在安静环境中使用手机完成录音。")
    expected_seconds: int = Field(default=180, ge=30, le=900)
    min_seconds: int = Field(default=30, ge=1, le=900)
    max_seconds: int = Field(default=480, ge=30, le=900)
    consent_version: str = Field(default="consent-v2-mimo-asr", max_length=64)


class StudyUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    text: str | None = Field(default=None, min_length=1)
    instructions: str | None = None
    expected_seconds: int | None = Field(default=None, ge=30, le=900)
    min_seconds: int | None = Field(default=None, ge=1, le=900)
    max_seconds: int | None = Field(default=None, ge=30, le=900)
    consent_version: str | None = Field(default=None, min_length=1, max_length=64)


class StudyStatsOut(BaseModel):
    invites_total: int = 0
    participants_submitted: int = 0
    recordings_total: int = 0
    processing: int = 0
    quality_high: int = 0
    quality_review: int = 0
    quality_reject: int = 0
    review_pending: int = 0
    review_approved: int = 0
    review_rejected: int = 0


class AdminStudyOut(BaseModel):
    study: StudyOut
    stats: StudyStatsOut


class AdminRecordingOut(BaseModel):
    participant_code: str
    invite_id: str
    invite_status: str
    invite_attempt_count: int
    attempt: AttemptOut
    reviewer_username: str | None = None
    quality_reasons: list[str] = Field(default_factory=list)
    audio_variants: list[str] = Field(default_factory=list)


class QCUpdateRequest(BaseModel):
    qc_status: str = Field(pattern="^(pending|pass|review|reject)$")
    note: str | None = Field(default=None, max_length=2000)


class ReviewUpdateRequest(BaseModel):
    review_status: str = Field(pattern="^(pending|approved|rejected)$")
    note: str | None = Field(default=None, max_length=2000)


class BulkReviewRequest(ReviewUpdateRequest):
    attempt_ids: list[str] = Field(min_length=1, max_length=200)


class ExportRequest(BaseModel):
    study_id: str
    variant: str = Field(default="both", pattern="^(original|normalized|both)$")


class ExportOut(BaseModel):
    id: str
    state: str
    variant: str
    download_url: str | None = None
    error_message: str | None = None
