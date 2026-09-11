from app.audio import extension_for_mime, qc_status_for_duration
from app.schemas import AttemptCreateRequest


def test_extension_for_mime():
    assert extension_for_mime("audio/webm;codecs=opus") == ".webm"
    assert extension_for_mime("audio/mp4") == ".m4a"
    assert extension_for_mime(None) == ".webm"


def test_short_recordings_are_kept_for_review():
    assert qc_status_for_duration(30) == "review"
    assert qc_status_for_duration(180) == "pass"


def test_attempt_metadata_accepts_legacy_long_user_agent():
    request = AttemptCreateRequest(browser_family="x" * 120, os_family="y" * 120)
    assert len(request.browser_family or "") == 120
