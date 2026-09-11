import argparse
import logging
import time
from pathlib import Path

from sqlalchemy import select

from .audio import extension_for_mime, move_original, normalize, probe, qc_status_for_duration, sha256_file, volume_metrics
from .config import get_settings
from .db import SessionLocal
from .models import Invite, ProcessingJob, RecordingAttempt, utcnow


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice-collector-worker")
settings = get_settings()


def claim_one() -> tuple[str, str] | None:
    db = SessionLocal()
    try:
        job = db.scalar(select(ProcessingJob).where(ProcessingJob.state == "queued").order_by(ProcessingJob.created_at).with_for_update(skip_locked=True))
        if not job:
            db.rollback()
            return None
        attempt = db.get(RecordingAttempt, job.attempt_id)
        invite = db.get(Invite, attempt.invite_id) if attempt else None
        if not attempt or not invite:
            job.state = "failed"
            job.last_error = "录音或邀请码不存在"
            db.commit()
            return None
        job.state = "processing"
        job.claimed_at = utcnow()
        attempt.state = "processing"
        db.commit()
        return job.id, attempt.id
    finally:
        db.close()


def process_one() -> bool:
    claimed = claim_one()
    if not claimed:
        return False
    job_id, attempt_id = claimed
    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, job_id)
        attempt = db.get(RecordingAttempt, attempt_id)
        invite = db.get(Invite, attempt.invite_id) if attempt else None
        if not job or not attempt or not invite:
            return True
        source = settings.media_root / (attempt.original_path or "")
        if not source.is_file():
            raise ValueError("上传源文件不存在")
        info = probe(source)
        duration = float(info["duration_seconds"])
        if duration < 1 or duration > settings.max_recording_seconds:
            raise ValueError(f"录音时长不符合限制: {duration:.1f}s")
        original_dir = settings.media_root / "original" / invite.participant_code
        normalized_dir = settings.media_root / "normalized" / invite.participant_code
        original_path = original_dir / f"{attempt.id}{extension_for_mime(attempt.original_mime)}"
        normalized_path = normalized_dir / f"{attempt.id}.wav"
        move_original(source, original_path)
        normalize(original_path, normalized_path)
        original_hash = sha256_file(original_path)
        normalized_hash = sha256_file(normalized_path)
        metrics = {**info, **volume_metrics(original_path)}
        attempt.original_path = str(original_path.relative_to(settings.media_root))
        attempt.normalized_path = str(normalized_path.relative_to(settings.media_root))
        attempt.original_sha256 = original_hash
        attempt.normalized_sha256 = normalized_hash
        attempt.duration_seconds = duration
        attempt.sample_rate = info.get("sample_rate")
        attempt.channels = info.get("channels")
        attempt.qc_metrics = metrics
        attempt.qc_status = qc_status_for_duration(duration)
        attempt.state = "ready"
        attempt.error_message = None
        job.state = "done"
        job.finished_at = utcnow()
        db.commit()
        logger.info("processed attempt=%s duration=%.2f", attempt.id, duration)
        return True
    except Exception as exc:  # worker must turn failures into inspectable state
        logger.exception("failed attempt=%s", attempt.id)
        attempt.state = "failed"
        attempt.qc_status = "reject"
        attempt.error_message = str(exc)[:2000]
        job.state = "failed"
        job.retries += 1
        job.last_error = str(exc)[:2000]
        job.finished_at = utcnow()
        db.commit()
        return True
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.once:
        process_one()
        return
    while True:
        process_one()
        time.sleep(2)


if __name__ == "__main__":
    main()
