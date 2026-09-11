from app.audio import assess_recording_quality, extension_for_mime, qc_status_for_duration
from app.schemas import AttemptCreateRequest


def test_extension_for_mime():
    assert extension_for_mime("audio/webm;codecs=opus") == ".webm"
    assert extension_for_mime("audio/mp4") == ".m4a"
    assert extension_for_mime(None) == ".webm"


def test_short_recordings_are_kept_for_review():
    assert qc_status_for_duration(30) == "review"
    assert qc_status_for_duration(180) == "pass"


def test_recording_quality_uses_task_duration_and_conservative_volume_thresholds():
    assert assess_recording_quality(60, 30, 90, {"mean_volume_db": -28, "max_volume_db": -3}) == ("pass", [])
    status, reasons = assess_recording_quality(20, 30, 90, {"mean_volume_db": -50, "max_volume_db": -20})
    assert status == "review"
    assert set(reasons) == {"录音短于任务要求", "平均音量过低", "峰值音量过低"}


def test_attempt_metadata_accepts_legacy_long_user_agent():
    request = AttemptCreateRequest(browser_family="x" * 120, os_family="y" * 120)
    assert len(request.browser_family or "") == 120
