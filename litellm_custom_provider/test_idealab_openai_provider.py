import json

from idealab_openai_provider import parse_openai_sse_line


def sse_line(payload):
    return "data: " + json.dumps(payload, ensure_ascii=False)


def test_parse_openai_sse_line_drops_reasoning_content():
    payload = {
        "choices": [
            {
                "index": 0,
                "delta": {"reasoning_content": "hidden", "content": ""},
            }
        ]
    }

    assert parse_openai_sse_line(sse_line(payload)) is None


def test_parse_openai_sse_line_returns_visible_content_chunk():
    payload = {
        "choices": [
            {
                "index": 0,
                "delta": {"reasoning_content": "", "content": "hello"},
            }
        ]
    }

    assert parse_openai_sse_line(sse_line(payload)) == {
        "text": "hello",
        "index": 0,
        "is_finished": False,
        "finish_reason": "",
        "usage": None,
        "tool_use": None,
    }


def test_parse_openai_sse_line_returns_finish_chunk():
    payload = {
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }
        ]
    }

    assert parse_openai_sse_line(sse_line(payload)) == {
        "text": "",
        "index": 0,
        "is_finished": True,
        "finish_reason": "stop",
        "usage": None,
        "tool_use": None,
    }


def test_parse_openai_sse_line_returns_tool_call_chunk():
    payload = {
        "choices": [
            {
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "Read", "arguments": "{\"file_path\":"},
                        }
                    ]
                },
            }
        ]
    }

    assert parse_openai_sse_line(sse_line(payload)) == {
        "text": "",
        "index": 0,
        "is_finished": False,
        "finish_reason": "",
        "usage": None,
        "tool_use": {
            "index": 0,
            "id": "call_1",
            "type": "function",
            "function": {"name": "Read", "arguments": "{\"file_path\":"},
        },
    }
