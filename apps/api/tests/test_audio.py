from app.audio import extension_for_mime


def test_extension_for_mime():
    assert extension_for_mime("audio/webm;codecs=opus") == ".webm"
    assert extension_for_mime("audio/mp4") == ".m4a"
    assert extension_for_mime(None) == ".webm"

