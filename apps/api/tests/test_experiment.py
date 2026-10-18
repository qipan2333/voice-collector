import csv
import io
import zipfile
from datetime import timedelta

import pytest
from sqlalchemy.orm import sessionmaker

from app import worker
from app.main import app, _build_export
from app.models import ExportJob, Invite, RecordingAttempt, Study, utcnow
from test_admin import build_client

PROFILE = {"name": "同学甲", "school": "测试学校", "grade": "一年级", "class_name": "1班", "phone": "13800138000", "student_number": "00123"}


@pytest.fixture
def experiment(tmp_path, monkeypatch):
    client, db, token = build_client()
    client.cookies.set("participant_session", token)
    study = db.get(Study, "study-1")
    study.school_options = [PROFILE["school"]]
    study.grade_options = [PROFILE["grade"]]
    study.class_options = [PROFILE["class_name"]]
    study.max_seconds = 480
    study.expected_seconds = 180
    db.get(Invite, "invite-1").status = "active"
    db.get(RecordingAttempt, "attempt-1").recording_round = 0
    db.commit()
    factory = sessionmaker(bind=db.bind, expire_on_commit=False)
    monkeypatch.setattr(worker, "SessionLocal", factory)
    monkeypatch.setattr("app.main.SessionLocal", factory)
    monkeypatch.setattr("app.main.settings.media_root", tmp_path)
    (tmp_path / "incoming").mkdir()
    (tmp_path / "exports").mkdir()
    try:
        yield client, db, tmp_path
    finally:
        app.dependency_overrides.clear()
        db.close()


def prepare(client):
    context = client.get("/api/v1/participant/context").json()
    assert client.post("/api/v1/participant/consent", json={"confirmed": True, "policy_version": context["study"]["consent_version"]}).status_code == 200
    assert client.put("/api/v1/participant/profile", json=PROFILE).status_code == 200


def upload(client, task_type, duration):
    result = client.post("/api/v1/participant/attempts", json={"task_type": task_type, "client_duration_seconds": duration})
    assert result.status_code == 200, result.text
    attempt_id = result.json()["id"]
    assert client.put(f"/api/v1/participant/attempts/{attempt_id}/content", content=b"fake audio for mocked decoder", headers={"Content-Type": "audio/wav"}).status_code == 200
    assert client.post(f"/api/v1/participant/attempts/{attempt_id}/finalize").status_code == 200
    return attempt_id


def mock_audio(monkeypatch, duration):
    monkeypatch.setattr(worker, "probe", lambda _: {"duration_seconds": duration, "sample_rate": 16000, "channels": 1})
    monkeypatch.setattr(worker, "move_original", lambda source, dest: (dest.parent.mkdir(parents=True, exist_ok=True), dest.write_bytes(source.read_bytes())))
    monkeypatch.setattr(worker, "normalize", lambda source, dest: (dest.parent.mkdir(parents=True, exist_ok=True), dest.write_bytes(source.read_bytes())))
    monkeypatch.setattr(worker, "volume_metrics", lambda _: {"mean_volume_db": -20, "max_volume_db": -5})


def test_consent_and_profile_required_and_version_checked(experiment):
    client, db, _ = experiment
    assert client.get("/api/v1/participant/context").json()["consent_confirmed"] is False
    assert client.put("/api/v1/participant/profile", json=PROFILE).status_code == 403
    assert client.post("/api/v1/participant/attempts", json={}).status_code == 403
    version = db.get(Study, "study-1").consent_version
    assert client.post("/api/v1/participant/consent", json={"confirmed": False, "policy_version": version}).status_code == 422
    assert client.post("/api/v1/participant/consent", json={"confirmed": True, "policy_version": "old"}).status_code == 409
    assert client.post("/api/v1/participant/consent", json={"confirmed": True, "policy_version": version}).status_code == 200
    assert client.post("/api/v1/participant/attempts", json={}).status_code == 403
    for field, value in [("school", "其他学校"), ("name", "   "), ("phone", "123"), ("student_number", "")]:
        assert client.put("/api/v1/participant/profile", json={**PROFILE, field: value}).status_code == 422
    assert client.put("/api/v1/participant/profile", json=PROFILE).status_code == 200
    assert client.get("/api/v1/participant/context").json()["participant_info"] == PROFILE


def test_two_tasks_duration_completion_retry_and_reopen(experiment, monkeypatch):
    client, db, _ = experiment
    prepare(client)
    assert client.post("/api/v1/participant/attempts", json={"task_type": "self_expression", "client_duration_seconds": 180}).status_code == 409
    mock_audio(monkeypatch, 12)
    reading_id = upload(client, "reading", 12)
    assert client.get("/api/v1/participant/context").json()["invite_status"] != "submitted"
    assert worker.process_one()
    assert client.get(f"/api/v1/participant/attempts/{reading_id}/status").json()["state"] == "ready"
    # Finalize is idempotent after processing; duplicate submissions stay blocked.
    assert client.post(f"/api/v1/participant/attempts/{reading_id}/finalize").json()["state"] == "ready"
    assert client.post("/api/v1/participant/attempts", json={"task_type": "reading", "client_duration_seconds": 12}).status_code == 409
    assert client.post("/api/v1/participant/attempts", json={"task_type": "self_expression", "client_duration_seconds": 179}).status_code == 422
    # The worker checks real duration, even if the client claims 180 seconds.
    failed_id = upload(client, "self_expression", 180)
    assert worker.process_one()
    assert client.get(f"/api/v1/participant/attempts/{failed_id}/status").json()["state"] == "failed"
    assert client.get("/api/v1/participant/context").json()["invite_status"] != "submitted"
    mock_audio(monkeypatch, 180)
    expression_id = upload(client, "self_expression", 180)
    assert worker.process_one()
    context = client.get("/api/v1/participant/context").json()
    assert context["invite_status"] == "submitted"
    assert client.get(f"/api/v1/participant/attempts/{expression_id}/status").json()["state"] == "ready"
    recordings = client.get("/api/v1/admin/studies/study-1/recordings").json()["items"]
    assert all(row["participant_info"] == PROFILE for row in recordings)
    assert {row["attempt"]["task_type"] for row in recordings} == {"reading", "self_expression"}
    assert client.post("/api/v1/admin/invites/invite-1/reopen").status_code == 200
    context = client.get("/api/v1/participant/context").json()
    assert context["recording_round"] == 2
    assert context["invite_status"] == "reopened"
    assert client.post("/api/v1/participant/attempts", json={"task_type": "self_expression", "client_duration_seconds": 180}).status_code == 409
    assert client.post("/api/v1/participant/attempts", json={"task_type": "reading", "client_duration_seconds": 12}).status_code == 200


def test_live_study_options_can_be_configured_without_changing_text(experiment):
    client, db, _ = experiment
    before = db.get(Study, "study-1").text_version
    response = client.patch("/api/v1/admin/studies/study-1", json={"school_options": [" 新学校 ", "新学校"]})
    assert response.status_code == 200
    assert response.json()["school_options"] == ["新学校"]
    assert response.json()["text_version"] == before
    assert client.patch("/api/v1/admin/studies/study-1", json={"text": "不能改"}).status_code == 409
    assert client.patch("/api/v1/admin/studies/study-1", json={"school_options": [" "]}).status_code == 422


def test_export_contains_task_type_round_and_profile(experiment):
    client, db, media_root = experiment
    prepare(client)
    job = ExportJob(id="test-export", study_id="study-1", variant="both", expires_at=utcnow() + timedelta(hours=1))
    db.add(job)
    db.commit()
    _build_export(job.id)
    db.refresh(job)
    assert job.state == "done", job.error_message
    with zipfile.ZipFile(media_root.parent / job.path) as archive:
        rows = list(csv.DictReader(io.StringIO(archive.read("manifest.csv").decode())))
        assert rows[0]["task_type"] == "reading"
        assert rows[0]["student_number"] == "00123"
        assert rows[0]["name"] == PROFILE["name"]
        assert "自我表述题" in archive.read("README.txt").decode()


def test_migration_preserves_readings_and_requires_new_consent(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, MetaData, Table, select

    url = f"sqlite:///{tmp_path / 'migration.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    config = Config("alembic.ini")
    command.upgrade(config, "3b8e6d62b1a4")
    engine = create_engine(url)
    metadata = MetaData()
    studies = Table("studies", metadata, autoload_with=engine)
    invites = Table("invites", metadata, autoload_with=engine)
    attempts = Table("recording_attempts", metadata, autoload_with=engine)
    now = utcnow()
    with engine.begin() as conn:
        conn.execute(studies.insert().values(id="legacy", title="原任务", text="原文不覆盖", text_version="v1", instructions="说明", status="open", expected_seconds=60, min_seconds=30, max_seconds=90, consent_version="consent-v1", created_at=now, updated_at=now))
        conn.execute(invites.insert().values(id="legacy-invite", study_id="legacy", participant_code="P1", token_digest="legacy-token", status="submitted", submitted_at=now, created_at=now))
        conn.execute(attempts.insert().values(id="legacy-audio", invite_id="legacy-invite", attempt_no=1, state="ready", qc_status="pass", review_status="approved", created_at=now, updated_at=now))
    command.upgrade(config, "head")
    metadata = MetaData()
    studies = Table("studies", metadata, autoload_with=engine)
    invites = Table("invites", metadata, autoload_with=engine)
    attempts = Table("recording_attempts", metadata, autoload_with=engine)
    with engine.connect() as conn:
        study = conn.execute(select(studies)).mappings().one()
        invite = conn.execute(select(invites)).mappings().one()
        attempt = conn.execute(select(attempts)).mappings().one()
        assert study["text"] == "原文不覆盖"
        assert study["consent_version"] == "consent-v3-experiment"
        assert study["school_options"] == []
        assert study["self_expression_prompt"].startswith("介绍一下")
        assert invite["status"] == "active"
        assert attempt["task_type"] == "reading"
        assert attempt["recording_round"] == invite["recording_round"] == 1
        assert attempt["review_status"] == "approved"
    engine.dispose()
