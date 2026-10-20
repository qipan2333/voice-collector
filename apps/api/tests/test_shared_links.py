from datetime import timedelta

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, create_engine, func, select

from app.main import app
from app.models import Invite, RecordingAttempt, Study, utcnow
from app.security import digest
from test_admin import build_client
from test_experiment import PROFILE, prepare


def test_shared_link_is_stable_and_every_visit_is_isolated():
    client, db, _ = build_client()
    other = TestClient(app)
    try:
        detail = client.get("/api/v1/admin/studies/study-1").json()
        link = detail["join_url"]
        token = link.rsplit("/", 1)[1]
        for count in (1, 100):
            result = client.post("/api/v1/admin/invites/bulk", json={"study_id": "study-1", "count": count})
            assert result.status_code == 200
            assert [row["url"] for row in result.json()] == [link]
        assert db.scalar(select(func.count(Invite.id))) == 2
        assert client.get("/api/v1/admin/studies").json()["items"][0].get("join_url")

        assert client.post("/api/v1/participant/exchange", json={"token": token}).status_code == 200
        first = client.get("/api/v1/participant/context").json()
        first_cookie = client.cookies.get("participant_session")
        prepare(client)
        attempt = client.post("/api/v1/participant/attempts", json={"task_type": "reading"}).json()

        assert other.post("/api/v1/participant/exchange", json={"token": token}).status_code == 200
        second = other.get("/api/v1/participant/context").json()
        assert second["participant_code"] != first["participant_code"]
        assert second["attempts"] == []
        assert second["participant_info"] is None
        assert second["consent_confirmed"] is False
        assert other.get(f"/api/v1/participant/attempts/{attempt['id']}/status").status_code == 404
        assert client.get("/api/v1/participant/context").json()["participant_info"] == PROFILE

        # Reopening in the same browser after completion starts a new run too.
        first_invite = db.scalar(select(Invite).where(Invite.participant_code == first["participant_code"]))
        first_invite.status = "submitted"
        first_invite.submitted_at = utcnow()
        db.commit()
        assert client.post("/api/v1/participant/exchange", json={"token": token}).status_code == 200
        third = client.get("/api/v1/participant/context").json()
        assert len({first["participant_code"], second["participant_code"], third["participant_code"]}) == 3
        assert third["attempts"] == []
        assert third["participant_info"] is None
        assert third["consent_confirmed"] is False
        assert third["invite_status"] == "active"
        assert db.get(RecordingAttempt, attempt["id"]) is not None
        assert client.cookies.get("participant_session") != first_cookie
        # A participant never receives the task's distribution credential in context.
        assert "join_token" not in third["study"]
        assert "join_url" not in third
        assert client.get("/api/v1/admin/studies/study-1").json()["join_url"] == link
        assert client.post("/api/v1/admin/studies/study-1/close").status_code == 200
        assert other.post("/api/v1/participant/exchange", json={"token": token}).status_code == 403
        assert client.post("/api/v1/admin/studies/study-1/open").status_code == 200
        assert client.get("/api/v1/admin/studies/study-1").json()["join_url"] == link
        assert other.post("/api/v1/participant/exchange", json={"token": "invalid-token-000000"}).status_code == 404
        legacy = db.get(Invite, "invite-1")
        legacy.token_digest = digest("legacy-invite-token-000000")
        db.commit()
        assert other.post("/api/v1/participant/exchange", json={"token": "legacy-invite-token-000000"}).status_code == 404
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_shared_link_migration_preserves_studies_and_clears_history(tmp_path, monkeypatch):
    from app.config import get_settings

    url = f"sqlite:///{tmp_path / 'migration.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    media = tmp_path / "recordings"
    monkeypatch.setattr(get_settings(), "media_root", media)
    config = Config("alembic.ini")
    command.upgrade(config, "7e902f5c81a2")
    engine = create_engine(url)
    metadata = MetaData()
    metadata.reflect(bind=engine)
    now = utcnow()
    original = media / "original/old.wav"
    normalized = media / "normalized/old.wav"
    incoming = media / "incoming/old-attempt.source"
    export = tmp_path / "exports/old.zip"
    outside = tmp_path / "keep.txt"
    for path in (original, normalized, incoming, export, outside):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"old content")
    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        conn.execute(metadata.tables["admin_users"].insert().values(id="admin", username="researcher", password_hash="keep", is_active=True, created_at=now))
        conn.execute(metadata.tables["admin_sessions"].insert().values(id="admin-session", user_id="admin", session_digest="admin-session", expires_at=now + timedelta(hours=1), created_at=now))
        for index, status in enumerate(("open", "closed", "archived", "draft")):
            conn.execute(metadata.tables["studies"].insert().values(id=f"study-{index}", title=f"原任务{index}", text="自定义朗读题", self_expression_prompt="自定义表述题", text_version="custom-v2", instructions="原说明", school_options=["学校"], grade_options=["初一"], class_options=["一班"], status=status, expected_seconds=180, min_seconds=1, max_seconds=480, consent_version="custom-consent", created_at=now, updated_at=now))
        conn.execute(metadata.tables["invites"].insert().values(id="old-invite", study_id="study-0", participant_code="P001", participant_info=PROFILE, recording_round=2, token_digest=digest("old-link-token-000000"), status="submitted", created_at=now))
        conn.execute(metadata.tables["participant_sessions"].insert().values(id="old-session", invite_id="old-invite", session_digest="old", expires_at=now, created_at=now))
        conn.execute(metadata.tables["consent_receipts"].insert().values(id="old-consent", invite_id="old-invite", policy_version="custom-consent", confirmed=True, confirmed_at=now))
        conn.execute(metadata.tables["recording_attempts"].insert().values(id="old-attempt", invite_id="old-invite", attempt_no=1, state="ready", qc_status="pass", review_status="approved", original_path="original/old.wav", normalized_path="normalized/old.wav", created_at=now, updated_at=now))
        conn.execute(metadata.tables["recording_attempts"].insert().values(id="outside-attempt", invite_id="old-invite", attempt_no=2, state="failed", qc_status="reject", review_status="pending", original_path="../keep.txt", created_at=now, updated_at=now))
        conn.execute(metadata.tables["processing_jobs"].insert().values(id="old-job", attempt_id="old-attempt", state="queued", retries=0, created_at=now))
        conn.execute(metadata.tables["export_jobs"].insert().values(id="old-export", study_id="study-0", variant="both", state="done", path="exports/old.zip", created_at=now, expires_at=now))
        conn.execute(metadata.tables["export_jobs"].insert().values(id="outside-export", study_id="study-0", variant="both", state="done", path="../keep.txt", created_at=now, expires_at=now))
        conn.execute(metadata.tables["audit_events"].insert().values(id="old-audit", actor_type="admin", action="study_opened", subject_id="study-0", created_at=now))
    command.upgrade(config, "head")
    metadata = MetaData()
    metadata.reflect(bind=engine)
    with engine.connect() as conn:
        rows = conn.execute(select(metadata.tables["studies"])).mappings().all()
        assert len(rows) == 4
        assert len({row["join_token"] for row in rows}) == 4
        for row in rows:
            assert row["status"] == "draft"
            assert row["title"].startswith("原任务")
            assert row["text"] == "自定义朗读题"
            assert row["self_expression_prompt"] == "自定义表述题"
            assert row["text_version"] == "custom-v2"
            assert row["instructions"] == "原说明"
            assert row["consent_version"] == "custom-consent"
            assert row["school_options"] == ["学校"]
            assert row["grade_options"] == ["初一"]
            assert row["class_options"] == ["一班"]
        for name in ("processing_jobs", "recording_attempts", "consent_receipts", "participant_sessions", "invites", "export_jobs", "audit_events"):
            assert conn.scalar(select(func.count()).select_from(metadata.tables[name])) == 0
        assert conn.scalar(select(func.count()).select_from(metadata.tables["admin_users"])) == 1
        assert conn.scalar(select(func.count()).select_from(metadata.tables["admin_sessions"])) == 1
        tokens = {row["id"]: row["join_token"] for row in rows}
    assert all(not path.exists() for path in (original, normalized, incoming, export))
    assert outside.read_bytes() == b"old content"
    # Running upgrade again must never reset newly collected data or rotate links.
    with engine.begin() as conn:
        conn.execute(metadata.tables["studies"].update().where(metadata.tables["studies"].c.id == "study-0").values(status="open"))
        conn.execute(metadata.tables["invites"].insert().values(id="new-invite", study_id="study-0", participant_code="new", recording_round=1, token_digest="new", status="submitted", created_at=now))
        conn.execute(metadata.tables["recording_attempts"].insert().values(id="new-attempt", invite_id="new-invite", attempt_no=1, state="ready", task_type="reading", recording_round=1, qc_status="pass", review_status="pending", original_path="original/new.wav", created_at=now, updated_at=now))
    new_audio = media / "original/new.wav"
    new_audio.write_bytes(b"new recording")
    command.upgrade(config, "head")
    with engine.connect() as conn:
        assert dict(conn.execute(select(metadata.tables["studies"].c.id, metadata.tables["studies"].c.join_token)).all()) == tokens
        assert conn.scalar(select(metadata.tables["studies"].c.status).where(metadata.tables["studies"].c.id == "study-0")) == "open"
        assert conn.scalar(select(func.count()).select_from(metadata.tables["recording_attempts"])) == 1
    assert new_audio.read_bytes() == b"new recording"
    engine.dispose()
