from app.main import _mimo_delta_content


def test_mimo_delta_content_extracts_text():
    payload = '{"choices":[{"delta":{"content":"春天来了"}}]}'
    assert _mimo_delta_content(payload) == "春天来了"


def test_mimo_delta_content_ignores_non_text_delta():
    assert _mimo_delta_content('{"choices":[{"delta":{}}]}') == ""
