import json
from typing import Any, AsyncIterator, Dict, Iterator, Optional

import httpx

try:
    from litellm import CustomLLM
except Exception:
    class CustomLLM:  # type: ignore
        pass


DROP_OPTIONAL_PARAMS = {
    "stream",
    "stream_options",
    "custom_llm_provider",
    "metadata",
    "user",
    "no-log",
}


def _normalize_model(model: str) -> str:
    if "/" in model:
        return model.split("/", 1)[1]
    return model


def _build_payload(model: str, messages: list, optional_params: Dict[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "model": _normalize_model(model),
        "messages": messages,
        "stream": True,
    }
    for key, value in optional_params.items():
        if key in DROP_OPTIONAL_PARAMS or value is None:
            continue
        payload[key] = value
    return payload


def _completion_url(api_base: str) -> str:
    return api_base.rstrip("/") + "/chat/completions"


def parse_openai_sse_line(line: str) -> Optional[Dict[str, Any]]:
    line = line.strip()
    if not line or not line.startswith("data:"):
        return None

    data = line[len("data:") :].strip()
    if not data or data == "[DONE]":
        return None

    payload = json.loads(data)
    choices = payload.get("choices") or []
    if not choices:
        return None

    choice = choices[0]
    index = choice.get("index", 0)
    finish_reason = choice.get("finish_reason")
    if finish_reason:
        return {
            "text": "",
            "index": index,
            "is_finished": True,
            "finish_reason": finish_reason,
            "usage": payload.get("usage"),
            "tool_use": None,
        }

    delta = choice.get("delta") or {}
    tool_calls = delta.get("tool_calls") or []
    if tool_calls:
        return {
            "text": "",
            "index": index,
            "is_finished": False,
            "finish_reason": "",
            "usage": None,
            "tool_use": tool_calls[0],
        }

    content = delta.get("content")
    if content:
        return {
            "text": content,
            "index": index,
            "is_finished": False,
            "finish_reason": "",
            "usage": None,
            "tool_use": None,
        }

    return None


class IdealabOpenAIProvider(CustomLLM):
    def streaming(
        self,
        model: str,
        messages: list,
        api_base: str,
        custom_prompt_dict: dict,
        model_response,
        print_verbose,
        encoding,
        api_key,
        logging_obj,
        optional_params: dict,
        acompletion=None,
        litellm_params=None,
        logger_fn=None,
        headers={},
        timeout=None,
        client=None,
    ) -> Iterator[Dict[str, Any]]:
        request_headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        request_headers.update(headers or {})
        payload = _build_payload(model, messages, optional_params or {})
        request_timeout = timeout or httpx.Timeout(300.0, connect=30.0)

        with httpx.Client(timeout=request_timeout, trust_env=True) as http_client:
            with http_client.stream(
                "POST",
                _completion_url(api_base),
                headers=request_headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    chunk = parse_openai_sse_line(line)
                    if chunk is not None:
                        yield chunk

    async def astreaming(
        self,
        model: str,
        messages: list,
        api_base: str,
        custom_prompt_dict: dict,
        model_response,
        print_verbose,
        encoding,
        api_key,
        logging_obj,
        optional_params: dict,
        acompletion=None,
        litellm_params=None,
        logger_fn=None,
        headers={},
        timeout=None,
        client=None,
    ) -> AsyncIterator[Dict[str, Any]]:
        request_headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        request_headers.update(headers or {})
        payload = _build_payload(model, messages, optional_params or {})
        request_timeout = timeout or httpx.Timeout(300.0, connect=30.0)

        async with httpx.AsyncClient(timeout=request_timeout, trust_env=True) as http_client:
            async with http_client.stream(
                "POST",
                _completion_url(api_base),
                headers=request_headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    chunk = parse_openai_sse_line(line)
                    if chunk is not None:
                        yield chunk


idealab_openai_handler = IdealabOpenAIProvider()
