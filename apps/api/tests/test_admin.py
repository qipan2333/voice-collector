from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app
from app.models import AdminSession, AdminUser, ConsentReceipt, Invite, ParticipantSession, RecordingAttempt, Study, utcnow
from app.security import digest, hash_password


def build_client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    db = session_factory()
    user = AdminUser(id="admin-1", username="researcher", password_hash=hash_password("password"))
    session_token = "admin-session-token"
    participant_token = "participant-session-token"
    db.add_all([
        user,
        AdminSession(id="session-1", user_id=user.id, session_digest=digest(session_token), expires_at=utcnow() + timedelta(hours=1)),
        Study(id="study-1", title="任务一", text="第一段文本", text_version="v1", status="open", expected_seconds=60, min_seconds=30, max_seconds=90),
        Study(id="study-2", title="任务二", text="第二段文本", text_version="v1", status="draft", expected_seconds=60, min_seconds=30, max_seconds=90),
        Invite(id="invite-1", study_id="study-1", participant_code="P001", token_digest="token-1", status="submitted"),
        Invite(id="invite-2", study_id="study-2", participant_code="P001", token_digest="token-2", status="unused"),
        ParticipantSession(id="participant-session-1", invite_id="invite-1", session_digest=digest(participant_token), expires_at=utcnow() + timedelta(hours=1)),
        ConsentReceipt(id="consent-1", invite_id="invite-1", policy_version="consent-v1", confirmed=True),
        RecordingAttempt(id="attempt-1", invite_id="invite-1", attempt_no=1, state="ready", auto_quality_status="pass", review_status="pending", duration_seconds=58, original_path="missing.webm"),
    ])
    db.commit()

    def override_db():
        test_db = session_factory()
        try:
            yield test_db
        finally:
            test_db.close()

    app.dependency_overrides[get_db] = override_db
    client = TestClient(app)
    client.cookies.set("admin_session", session_token)
    return client, db, participant_token


def test_study_statistics_and_recordings_are_isolated():
    client, db, _ = build_client()
    try:
        response = client.get("/api/v1/admin/studies")
        assert response.status_code == 200
        items = {item["study"]["id"]: item for item in response.json()["items"]}
        assert items["study-1"]["stats"]["recordings_total"] == 1
        assert items["study-1"]["stats"]["quality_high"] == 1
        assert items["study-2"]["stats"]["recordings_total"] == 0

        recordings = client.get("/api/v1/admin/studies/study-1/recordings").json()
        assert recordings["total"] == 1
        assert recordings["items"][0]["participant_code"] == "P001"
        assert client.get("/api/v1/admin/studies/study-2/recordings").json()["total"] == 0
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_review_and_task_lifecycle():
    client, db, participant_token = build_client()
    try:
        reviewed = client.patch("/api/v1/admin/recordings/attempt-1/review", json={"review_status": "approved", "note": "清晰"})
        assert reviewed.status_code == 200
        assert reviewed.json()["review_status"] == "approved"
        assert reviewed.json()["review_note"] == "清晰"

        bulk = client.patch("/api/v1/admin/recordings/review/bulk", json={"attempt_ids": ["attempt-1"], "review_status": "pending"})
        assert bulk.status_code == 200
        assert bulk.json() == {"updated": 1}

        assert client.post("/api/v1/admin/studies/study-1/close").json()["status"] == "closed"
        client.cookies.set("participant_session", participant_token)
        blocked = client.post("/api/v1/participant/attempts", json={"client_duration_seconds": 30})
        assert blocked.status_code == 409
        assert client.post("/api/v1/admin/studies/study-1/archive").json()["status"] == "archived"
        assert client.post("/api/v1/admin/studies/study-1/restore").json()["status"] == "closed"
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_audio_endpoint_supports_range_requests(tmp_path, monkeypatch):
    client, db, _ = build_client()
    try:
        monkeypatch.setattr("app.main.settings.media_root", tmp_path)
        audio = tmp_path / "original" / "attempt-1.wav"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(b"RIFF" + b"0" * 4096)
        attempt = db.get(RecordingAttempt, "attempt-1")
        attempt.original_path = "original/attempt-1.wav"
        attempt.original_mime = "audio/wav"
        db.commit()
        response = client.get("/api/v1/admin/recordings/attempt-1/audio?variant=original", headers={"Range": "bytes=0-99"})
        assert response.status_code == 206
        assert len(response.content) == 100
    finally:
        app.dependency_overrides.clear()
        db.close()
