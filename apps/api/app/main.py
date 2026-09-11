import logging
import os
import uuid
import csv
import io
import zipfile
import asyncio
import base64
import json
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, Cookie, Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .audio import extension_for_mime
from .config import get_settings
from .db import Base, SessionLocal, engine, get_db
from .models import (
    AdminSession,
    AdminUser,
    AuditEvent,
    ConsentReceipt,
    ExportJob,
    Invite,
    ParticipantSession,
    ProcessingJob,
    RecordingAttempt,
    Study,
    utcnow,
)
from .schemas import (
    AdminLoginRequest,
    AttemptCreateRequest,
    AttemptOut,
    BulkInviteRequest,
    ConsentRequest,
    ExchangeRequest,
    ExportOut,
    ExportRequest,
    InviteOut,
    ParticipantContext,
    QCUpdateRequest,
    StudyCreateRequest,
    StudyOut,
)
from .security import digest, expires_in, hash_password, new_token, verify_otp, verify_password


settings = get_settings()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice-collector")
app = FastAPI(title="Voice Collector API", version="0.1.0")

allowed_origins = [settings.public_base_url.rstrip("/")]
if settings.app_env != "production":
    allowed_origins.extend(["http://localhost:5173", "http://127.0.0.1:5173"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Idempotency-Key", "X-ASR-Session-Id", "X-ASR-Sequence"],
)

_asr_rate_lock = asyncio.Lock()
_asr_global_requests: deque[float] = deque()
_asr_participant_requests: dict[str, float] = {}
_asr_semaphore = asyncio.Semaphore(8)


def _study_to_out(study: Study) -> StudyOut:
    return StudyOut.model_validate(study)


def _attempt_to_out(attempt: RecordingAttempt) -> AttemptOut:
    return AttemptOut.model_validate(attempt)


def _follow_along_enabled(study: Study) -> bool:
    return bool(
        settings.mimo_api_key
        and study.consent_version == settings.mimo_required_consent_version
    )


async def _reserve_asr_request(participant_key: str) -> None:
    now = time.monotonic()
    async with _asr_rate_lock:
        while _asr_global_requests and now - _asr_global_requests[0] >= 60:
            _asr_global_requests.popleft()
        last_request = _asr_participant_requests.get(participant_key)
        if last_request is not None and now - last_request < 11.5:
            raise HTTPException(status_code=429, detail="跟读识别请求过于频繁，请稍后继续")
        if len(_asr_global_requests) >= max(1, settings.mimo_asr_rpm_limit):
            raise HTTPException(status_code=429, detail="跟读识别繁忙，录音可继续进行")
        _asr_global_requests.append(now)
        _asr_participant_requests[participant_key] = now


async def _transcribe_mimo(wav_data: bytes) -> str:
    encoded = base64.b64encode(wav_data).decode("ascii")
    payload = {
        "model": settings.mimo_asr_model,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": {"data": f"data:audio/wav;base64,{encoded}"},
            }],
        }],
        "asr_options": {"language": "auto"},
        "stream": True,
    }
    transcript: list[str] = []
    timeout = httpx.Timeout(settings.mimo_asr_timeout_seconds)
    async with _asr_semaphore:
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                async with client.stream(
                    "POST",
                    f"{settings.mimo_base_url.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.mimo_api_key}"},
                    json=payload,
                ) as response:
                    if response.status_code == 429:
                        raise HTTPException(status_code=429, detail="跟读识别繁忙，录音可继续进行")
                    if response.status_code >= 400:
                        logger.warning("MiMo ASR failed status=%s", response.status_code)
                        raise HTTPException(status_code=503, detail="跟读识别暂时不可用，录音可继续进行")
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data or data == "[DONE]":
                            continue
                        try:
                            content = _mimo_delta_content(data)
                            if content:
                                transcript.append(content)
                        except (ValueError, KeyError, IndexError, TypeError):
                            continue
            except HTTPException:
                raise
            except (httpx.TimeoutException, httpx.NetworkError):
                raise HTTPException(status_code=503, detail="跟读识别连接超时，录音可继续进行") from None
    return "".join(transcript).strip()


def _mimo_delta_content(data: str) -> str:
    item = json.loads(data)
    content = item.get("choices", [{}])[0].get("delta", {}).get("content")
    return content if isinstance(content, str) else ""


def _audit(db: Session, action: str, actor_type: str, actor_id: str | None = None,
           subject_type: str | None = None, subject_id: str | None = None, payload: dict | None = None) -> None:
    db.add(AuditEvent(
        id=str(uuid.uuid4()), actor_type=actor_type, actor_id=actor_id, action=action,
        subject_type=subject_type, subject_id=subject_id, payload=payload,
    ))


def _participant_from_cookie(db: Session, cookie: str | None) -> tuple[ParticipantSession, Invite, Study]:
    if not cookie:
        raise HTTPException(status_code=401, detail="学生会话已失效")
    session = db.scalar(select(ParticipantSession).where(
        ParticipantSession.session_digest == digest(cookie),
        ParticipantSession.expires_at > utcnow(),
    ))
    if not session:
        raise HTTPException(status_code=401, detail="学生会话已失效")
    invite = db.get(Invite, session.invite_id)
    study = db.get(Study, invite.study_id) if invite else None
    if not invite or not study or invite.status in {"disabled", "withdrawn"}:
        raise HTTPException(status_code=403, detail="邀请码不可用")
    invite.last_access_at = utcnow()
    db.commit()
    return session, invite, study


def _admin_from_cookie(db: Session, cookie: str | None) -> AdminUser:
    if not cookie:
        raise HTTPException(status_code=401, detail="管理员会话已失效")
    session = db.scalar(select(AdminSession).where(
        AdminSession.session_digest == digest(cookie),
        AdminSession.expires_at > utcnow(),
    ))
    user = db.get(AdminUser, session.user_id) if session else None
    if not session or not user or not user.is_active:
        raise HTTPException(status_code=401, detail="管理员会话已失效")
    return user


def _export_path(job_id: str) -> Path:
    export_root = settings.media_root.parent / "exports"
    export_root.mkdir(parents=True, exist_ok=True)
    return export_root / f"{job_id}.zip"


def _build_export(job_id: str) -> None:
    db = SessionLocal()
    job = db.get(ExportJob, job_id)
    if not job:
        db.close()
        return
    job.state = "running"
    db.commit()
    try:
        study = db.get(Study, job.study_id)
        if not study:
            raise ValueError("任务不存在")
        rows = db.execute(
            select(RecordingAttempt, Invite)
            .join(Invite, Invite.id == RecordingAttempt.invite_id)
            .where(Invite.study_id == study.id)
            .order_by(Invite.participant_code, RecordingAttempt.attempt_no)
        ).all()
        destination = _export_path(job.id)
        manifest = io.StringIO()
        writer = csv.DictWriter(manifest, fieldnames=[
            "participant_code", "attempt_id", "attempt_no", "state", "qc_status",
            "duration_seconds", "original_mime", "original_size", "original_sha256",
            "normalized_sha256", "sample_rate", "channels", "text_version", "created_at",
        ])
        writer.writeheader()
        checksums: list[str] = []
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("README.txt", f"Study: {study.title}\nText version: {study.text_version}\n\n{study.text}\n")
            for attempt, invite in rows:
                writer.writerow({
                    "participant_code": invite.participant_code,
                    "attempt_id": attempt.id,
                    "attempt_no": attempt.attempt_no,
                    "state": attempt.state,
                    "qc_status": attempt.qc_status,
                    "duration_seconds": attempt.duration_seconds,
                    "original_mime": attempt.original_mime,
                    "original_size": attempt.original_size,
                    "original_sha256": attempt.original_sha256,
                    "normalized_sha256": attempt.normalized_sha256,
                    "sample_rate": attempt.sample_rate,
                    "channels": attempt.channels,
                    "text_version": study.text_version,
                    "created_at": attempt.created_at.isoformat(),
                })
                candidates: list[tuple[str, str | None, str | None]] = []
                if job.variant in {"original", "both"}:
                    candidates.append(("original", attempt.original_path, attempt.original_sha256))
                if job.variant in {"normalized", "both"}:
                    candidates.append(("normalized", attempt.normalized_path, attempt.normalized_sha256))
                for variant, relative, checksum in candidates:
                    if not relative:
                        continue
                    source = settings.media_root / relative
                    if not source.is_file():
                        continue
                    archive_name = f"{variant}/{invite.participant_code}/attempt-{attempt.attempt_no}-{source.name}"
                    archive.write(source, archive_name)
                    if checksum:
                        checksums.append(f"{checksum}  {archive_name}")
            archive.writestr("manifest.csv", manifest.getvalue())
            archive.writestr("checksums.sha256", "\n".join(checksums) + "\n")
        job.state = "done"
        job.path = str(destination.relative_to(settings.media_root.parent))
        db.commit()
    except Exception as exc:
        logger.exception("export failed job=%s", job.id)
        job.state = "failed"
        job.error_message = str(exc)[:2000]
        db.commit()
    finally:
        db.close()


@app.on_event("startup")
def startup() -> None:
    if settings.app_env == "production" and (settings.app_secret.startswith("change-me") or settings.admin_password == "change-me"):
        raise RuntimeError("生产环境必须修改 APP_SECRET 和 ADMIN_PASSWORD")
    Base.metadata.create_all(engine)
    db = SessionLocal()
    try:
        if not db.scalar(select(Study).limit(1)):
            db.add(Study(
                id=str(uuid.uuid4()), title="学生朗读录音任务",
                text="请在管理后台配置固定朗读文本。", text_version="v1",
                instructions="请在安静环境中使用手机完成录音，并保持手机位置稳定。",
                status="draft", expected_seconds=settings.expected_recording_seconds,
                min_seconds=30, max_seconds=settings.max_recording_seconds,
            ))
        if not db.scalar(select(AdminUser).where(AdminUser.username == settings.admin_username)):
            db.add(AdminUser(
                id=str(uuid.uuid4()), username=settings.admin_username,
                password_hash=hash_password(settings.admin_password),
                totp_secret=settings.admin_totp_secret or None,
            ))
        db.commit()
    finally:
        db.close()


@app.get("/health/live")
def health_live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
def health_ready(db: Session = Depends(get_db)) -> dict[str, object]:
    db.execute(select(func.count(Study.id)))
    usage = os.statvfs(settings.media_root)
    free_bytes = usage.f_bavail * usage.f_frsize
    return {
        "status": "ok",
        "free_bytes": free_bytes,
        "accepting_uploads": free_bytes >= 10 * 1024**3,
        "asr_configured": bool(settings.mimo_api_key),
    }


@app.post("/api/v1/participant/exchange")
def exchange(request: ExchangeRequest, response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    invite = db.scalar(select(Invite).where(Invite.token_digest == digest(request.token)))
    if not invite or invite.status in {"disabled", "withdrawn"}:
        raise HTTPException(status_code=404, detail="邀请码无效或已关闭")
    study = db.get(Study, invite.study_id)
    if not study or study.status != "open":
        raise HTTPException(status_code=403, detail="任务当前未开放")
    raw_session = new_token()
    invite.status = "active" if invite.status == "unused" else invite.status
    invite.first_seen_at = invite.first_seen_at or utcnow()
    invite.last_access_at = utcnow()
    db.add(ParticipantSession(
        id=str(uuid.uuid4()), invite_id=invite.id, session_digest=digest(raw_session),
        expires_at=expires_in(settings.participant_session_seconds),
    ))
    db.commit()
    response.set_cookie("participant_session", raw_session, httponly=True, secure=settings.app_env == "production", samesite="lax", max_age=settings.participant_session_seconds)
    return {"participant_code": invite.participant_code}


@app.get("/api/v1/participant/context", response_model=ParticipantContext)
def participant_context(participant_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> ParticipantContext:
    _, invite, study = _participant_from_cookie(db, participant_session)
    consent = db.scalar(select(ConsentReceipt).where(ConsentReceipt.invite_id == invite.id, ConsentReceipt.confirmed.is_(True)))
    attempts = db.scalars(select(RecordingAttempt).where(RecordingAttempt.invite_id == invite.id).order_by(RecordingAttempt.attempt_no)).all()
    return ParticipantContext(
        participant_code=invite.participant_code, study=_study_to_out(study),
        consent_confirmed=bool(consent), follow_along_enabled=_follow_along_enabled(study),
        attempts=[_attempt_to_out(item) for item in attempts],
    )


@app.post("/api/v1/participant/asr/chunks")
async def participant_asr_chunk(
    request: Request,
    participant_session: str | None = Cookie(default=None),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    session, invite, study = _participant_from_cookie(db, participant_session)
    if not _follow_along_enabled(study):
        raise HTTPException(status_code=503, detail="当前任务未启用跟读识别")
    consent = db.scalar(select(ConsentReceipt).where(
        ConsentReceipt.invite_id == invite.id,
        ConsentReceipt.policy_version == study.consent_version,
        ConsentReceipt.confirmed.is_(True),
    ))
    if not consent:
        raise HTTPException(status_code=403, detail="请先确认知情同意")
    asr_session_id = request.headers.get("x-asr-session-id", "")
    sequence_text = request.headers.get("x-asr-sequence", "")
    if len(asr_session_id) < 8 or len(asr_session_id) > 80:
        raise HTTPException(status_code=422, detail="跟读会话标识无效")
    try:
        sequence = int(sequence_text)
    except ValueError:
        raise HTTPException(status_code=422, detail="跟读分片序号无效") from None
    if sequence < 0 or sequence > 1000:
        raise HTTPException(status_code=422, detail="跟读分片序号无效")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    if content_type not in {"audio/wav", "audio/wave", "audio/x-wav"}:
        raise HTTPException(status_code=415, detail="跟读分片必须为 WAV 音频")
    wav_data = await request.body()
    if len(wav_data) < 44 or len(wav_data) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="跟读音频分片大小无效")
    if wav_data[:4] != b"RIFF" or wav_data[8:12] != b"WAVE":
        raise HTTPException(status_code=422, detail="跟读音频分片格式无效")
    await _reserve_asr_request(invite.id)
    started = time.monotonic()
    transcript = await _transcribe_mimo(wav_data)
    return {
        "sequence": sequence,
        "transcript": transcript,
        "latency_ms": round((time.monotonic() - started) * 1000),
    }


@app.post("/api/v1/participant/consent")
def participant_consent(request: ConsentRequest, participant_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> dict[str, bool]:
    _, invite, study = _participant_from_cookie(db, participant_session)
    if request.policy_version != study.consent_version:
        raise HTTPException(status_code=409, detail="知情同意说明已更新，请重新打开页面")
    if not request.confirmed:
        raise HTTPException(status_code=422, detail="必须确认已完成校外知情同意流程")
    existing = db.scalar(select(ConsentReceipt).where(ConsentReceipt.invite_id == invite.id, ConsentReceipt.policy_version == request.policy_version))
    if not existing:
        db.add(ConsentReceipt(id=str(uuid.uuid4()), invite_id=invite.id, policy_version=request.policy_version, confirmed=True))
    db.commit()
    return {"confirmed": True}


@app.post("/api/v1/participant/attempts", response_model=AttemptOut)
def create_attempt(request: AttemptCreateRequest, participant_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> AttemptOut:
    _, invite, _study = _participant_from_cookie(db, participant_session)
    consent = db.scalar(select(ConsentReceipt).where(ConsentReceipt.invite_id == invite.id, ConsentReceipt.confirmed.is_(True)))
    if not consent:
        raise HTTPException(status_code=403, detail="请先确认知情同意")
    count = db.scalar(select(func.count(RecordingAttempt.id)).where(RecordingAttempt.invite_id == invite.id)) or 0
    if count >= 3:
        raise HTTPException(status_code=409, detail="已达到最大录音次数，请联系研究人员重开")
    attempt = RecordingAttempt(
        id=str(uuid.uuid4()), invite_id=invite.id, attempt_no=count + 1,
        client_duration_seconds=request.client_duration_seconds,
        browser_family=request.browser_family, os_family=request.os_family,
        recorder_settings=request.recorder_settings,
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return _attempt_to_out(attempt)


@app.put("/api/v1/participant/attempts/{attempt_id}/content")
async def upload_attempt(attempt_id: str, request: Request, participant_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> dict[str, object]:
    _, invite, _study = _participant_from_cookie(db, participant_session)
    attempt = db.get(RecordingAttempt, attempt_id)
    if not attempt or attempt.invite_id != invite.id:
        raise HTTPException(status_code=404, detail="录音不存在")
    if attempt.state not in {"created", "uploading"}:
        raise HTTPException(status_code=409, detail="录音当前不可上传")
    length_header = request.headers.get("content-length")
    if length_header and int(length_header) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="录音文件超过限制")
    incoming = settings.media_root / "incoming" / f"{attempt.id}.source"
    total = 0
    with incoming.open("wb") as handle:
        async for chunk in request.stream():
            total += len(chunk)
            if total > settings.max_upload_bytes:
                incoming.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="录音文件超过限制")
            handle.write(chunk)
    if total == 0:
        incoming.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail="录音文件为空")
    attempt.original_path = str(incoming.relative_to(settings.media_root))
    attempt.original_mime = request.headers.get("content-type", "application/octet-stream").split(";", 1)[0]
    attempt.original_size = total
    attempt.state = "uploading"
    db.commit()
    return {"attempt_id": attempt.id, "bytes": total}


@app.post("/api/v1/participant/attempts/{attempt_id}/finalize", response_model=AttemptOut)
def finalize_attempt(attempt_id: str, participant_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> AttemptOut:
    _, invite, _study = _participant_from_cookie(db, participant_session)
    attempt = db.get(RecordingAttempt, attempt_id)
    if not attempt or attempt.invite_id != invite.id:
        raise HTTPException(status_code=404, detail="录音不存在")
    if not attempt.original_path or not (settings.media_root / attempt.original_path).exists():
        raise HTTPException(status_code=409, detail="请先上传录音文件")
    if attempt.state == "queued":
        return _attempt_to_out(attempt)
    attempt.state = "queued"
    attempt.submitted_at = utcnow()
    invite.status = "submitted"
    invite.submitted_at = attempt.submitted_at
    db.add(ProcessingJob(id=str(uuid.uuid4()), attempt_id=attempt.id))
    db.commit()
    return _attempt_to_out(attempt)


@app.get("/api/v1/participant/attempts/{attempt_id}/status", response_model=AttemptOut)
def attempt_status(attempt_id: str, participant_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> AttemptOut:
    _, invite, _study = _participant_from_cookie(db, participant_session)
    attempt = db.get(RecordingAttempt, attempt_id)
    if not attempt or attempt.invite_id != invite.id:
        raise HTTPException(status_code=404, detail="录音不存在")
    return _attempt_to_out(attempt)


@app.post("/api/v1/admin/login")
def admin_login(request: AdminLoginRequest, response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    user = db.scalar(select(AdminUser).where(AdminUser.username == request.username, AdminUser.is_active.is_(True)))
    if not user or not verify_password(user.password_hash, request.password) or not verify_otp(user.totp_secret, request.otp):
        raise HTTPException(status_code=401, detail="用户名、密码或验证码错误")
    raw_session = new_token()
    db.add(AdminSession(id=str(uuid.uuid4()), user_id=user.id, session_digest=digest(raw_session), expires_at=expires_in(settings.admin_session_seconds)))
    _audit(db, "admin_login", "admin", user.id)
    db.commit()
    response.set_cookie("admin_session", raw_session, httponly=True, secure=settings.app_env == "production", samesite="lax", max_age=settings.admin_session_seconds)
    return {"username": user.username}


@app.get("/api/v1/admin/dashboard")
def admin_dashboard(admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> dict[str, object]:
    user = _admin_from_cookie(db, admin_session)
    study = db.scalar(select(Study).order_by(Study.created_at.desc()))
    total = db.scalar(select(func.count(Invite.id)).where(Invite.study_id == study.id)) if study else 0
    submitted = db.scalar(select(func.count(Invite.id)).where(Invite.study_id == study.id, Invite.status == "submitted")) if study else 0
    processing = db.scalar(select(func.count(RecordingAttempt.id)).where(RecordingAttempt.state.in_(["queued", "processing"])))
    _ = user
    return {"study": _study_to_out(study) if study else None, "total": total or 0, "submitted": submitted or 0, "processing": processing or 0}


@app.post("/api/v1/admin/studies", response_model=StudyOut)
def create_study(request: StudyCreateRequest, admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> StudyOut:
    user = _admin_from_cookie(db, admin_session)
    study = Study(id=str(uuid.uuid4()), title=request.title, text=request.text, instructions=request.instructions,
                  text_version=f"v{int(datetime.now(timezone.utc).timestamp())}", status="draft",
                  expected_seconds=request.expected_seconds, min_seconds=request.min_seconds,
                  max_seconds=request.max_seconds, consent_version=request.consent_version)
    db.add(study)
    _audit(db, "study_created", "admin", user.id, "study", study.id)
    db.commit()
    return _study_to_out(study)


@app.post("/api/v1/admin/studies/{study_id}/open", response_model=StudyOut)
def open_study(study_id: str, admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> StudyOut:
    user = _admin_from_cookie(db, admin_session)
    study = db.get(Study, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="任务不存在")
    study.status = "open"
    _audit(db, "study_opened", "admin", user.id, "study", study.id)
    db.commit()
    return _study_to_out(study)


@app.post("/api/v1/admin/invites/bulk", response_model=list[InviteOut])
def create_invites(request: BulkInviteRequest, admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> list[InviteOut]:
    user = _admin_from_cookie(db, admin_session)
    study = db.get(Study, request.study_id)
    if not study:
        raise HTTPException(status_code=404, detail="任务不存在")
    current = db.scalar(select(func.count(Invite.id)).where(Invite.study_id == study.id)) or 0
    result: list[InviteOut] = []
    for index in range(request.count):
        code = f"P{current + index + 1:03d}"
        raw_token = new_token()
        invite = Invite(id=str(uuid.uuid4()), study_id=study.id, participant_code=code, token_digest=digest(raw_token), status="unused")
        db.add(invite)
        result.append(InviteOut(id=invite.id, participant_code=code, status=invite.status, url=f"{settings.public_base_url.rstrip('/')}/#/join/{raw_token}"))
    _audit(db, "invites_created", "admin", user.id, "study", study.id, {"count": request.count})
    db.commit()
    return result


@app.get("/api/v1/admin/recordings")
def list_recordings(admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db), limit: int = 100, offset: int = 0) -> dict[str, object]:
    _admin_from_cookie(db, admin_session)
    rows = db.execute(select(RecordingAttempt, Invite).join(Invite, Invite.id == RecordingAttempt.invite_id).order_by(RecordingAttempt.created_at.desc()).limit(min(limit, 200)).offset(max(offset, 0))).all()
    return {"items": [{"participant_code": invite.participant_code, "attempt": _attempt_to_out(attempt).model_dump()} for attempt, invite in rows]}


@app.get("/api/v1/admin/recordings/{attempt_id}/audio")
def download_audio(attempt_id: str, variant: str = "original", admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> FileResponse:
    _admin_from_cookie(db, admin_session)
    attempt = db.get(RecordingAttempt, attempt_id)
    if not attempt:
        raise HTTPException(status_code=404, detail="录音不存在")
    relative = attempt.normalized_path if variant == "normalized" else attempt.original_path
    if not relative:
        raise HTTPException(status_code=404, detail="该版本文件尚未生成")
    path = settings.media_root / relative
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path, filename=path.name, media_type="audio/wav" if variant == "normalized" else (attempt.original_mime or "application/octet-stream"))


@app.post("/api/v1/admin/invites/{invite_id}/reopen")
def reopen_invite(invite_id: str, admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> dict[str, str]:
    user = _admin_from_cookie(db, admin_session)
    invite = db.get(Invite, invite_id)
    if not invite:
        raise HTTPException(status_code=404, detail="邀请码不存在")
    invite.status = "reopened"
    invite.submitted_at = None
    _audit(db, "invite_reopened", "admin", user.id, "invite", invite.id)
    db.commit()
    return {"status": invite.status}


@app.patch("/api/v1/admin/recordings/{attempt_id}/qc", response_model=AttemptOut)
def update_qc(attempt_id: str, request: QCUpdateRequest, admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> AttemptOut:
    user = _admin_from_cookie(db, admin_session)
    attempt = db.get(RecordingAttempt, attempt_id)
    if not attempt:
        raise HTTPException(status_code=404, detail="录音不存在")
    attempt.qc_status = request.qc_status
    _audit(db, "recording_qc_updated", "admin", user.id, "recording_attempt", attempt.id, {"status": request.qc_status, "note": request.note})
    db.commit()
    return _attempt_to_out(attempt)


@app.post("/api/v1/admin/exports", response_model=ExportOut)
def create_export(request: ExportRequest, background_tasks: BackgroundTasks,
                  admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> ExportOut:
    user = _admin_from_cookie(db, admin_session)
    study = db.get(Study, request.study_id)
    if not study:
        raise HTTPException(status_code=404, detail="任务不存在")
    job = ExportJob(
        id=str(uuid.uuid4()), study_id=study.id, variant=request.variant, state="queued",
        expires_at=utcnow().replace(microsecond=0),
    )
    # 24 小时的过期时间不依赖数据库方言。
    from datetime import timedelta
    job.expires_at = utcnow() + timedelta(hours=24)
    db.add(job)
    _audit(db, "export_created", "admin", user.id, "export", job.id, {"variant": request.variant})
    db.commit()
    background_tasks.add_task(_build_export, job.id)
    return ExportOut(id=job.id, state=job.state, variant=job.variant)


@app.get("/api/v1/admin/exports/{job_id}", response_model=ExportOut)
def get_export(job_id: str, admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> ExportOut:
    _admin_from_cookie(db, admin_session)
    job = db.get(ExportJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="导出任务不存在")
    url = f"/api/v1/admin/exports/{job.id}/download" if job.state == "done" and job.path else None
    return ExportOut(id=job.id, state=job.state, variant=job.variant, download_url=url, error_message=job.error_message)


@app.get("/api/v1/admin/exports/{job_id}/download")
def download_export(job_id: str, admin_session: str | None = Cookie(default=None), db: Session = Depends(get_db)) -> FileResponse:
    _admin_from_cookie(db, admin_session)
    job = db.get(ExportJob, job_id)
    if not job or job.state != "done" or not job.path:
        raise HTTPException(status_code=404, detail="导出文件尚未准备好")
    if job.expires_at <= utcnow():
        raise HTTPException(status_code=410, detail="导出文件已过期")
    path = settings.media_root.parent / job.path
    if not path.is_file():
        raise HTTPException(status_code=404, detail="导出文件不存在")
    return FileResponse(path, filename=f"voice-collector-{job.id}.zip", media_type="application/zip")
