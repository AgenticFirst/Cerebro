"""Tests for cloud provider router endpoints with mocked httpx."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from cloud_providers.adapters import CREDENTIAL_KEYS


@pytest.fixture(autouse=True)
def _clear_credentials():
    """Ensure no stale in-memory credentials between tests."""
    from credentials import _credentials
    saved = dict(_credentials)
    yield
    _credentials.clear()
    _credentials.update(saved)


def _push_key(client, provider: str, key: str):
    """Push a credential to the backend via the /credentials endpoint."""
    env_key = CREDENTIAL_KEYS[provider]
    client.post("/credentials", json={"key": env_key, "value": key})


# ── /cloud/status ────────────────────────────────────────────────


def test_cloud_status_no_keys(client):
    res = client.get("/cloud/status")
    assert res.status_code == 200
    data = res.json()
    for provider in ("anthropic", "openai", "google"):
        assert data[provider]["has_key"] is False


def test_cloud_status_with_key(client):
    _push_key(client, "anthropic", "sk-ant-test-123")
    res = client.get("/cloud/status")
    assert res.status_code == 200
    assert res.json()["anthropic"]["has_key"] is True
    assert res.json()["openai"]["has_key"] is False


# ── /cloud/verify ────────────────────────────────────────────────


def test_verify_no_key(client):
    res = client.post("/cloud/verify", json={"provider": "anthropic"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is False
    assert "No API key" in data["error"]


@pytest.mark.anyio
async def test_verify_openai_success(client):
    _push_key(client, "openai", "sk-test-key")

    mock_response = AsyncMock()
    mock_response.status_code = 200

    with patch("cloud_providers.adapters.httpx.AsyncClient") as MockClient:
        instance = AsyncMock()
        instance.get = AsyncMock(return_value=mock_response)
        instance.__aenter__ = AsyncMock(return_value=instance)
        instance.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = instance

        res = client.post("/cloud/verify", json={"provider": "openai"})
        assert res.status_code == 200
        assert res.json()["ok"] is True


# ── /cloud/chat ──────────────────────────────────────────────────


def test_chat_no_key(client):
    res = client.post("/cloud/chat", json={
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "messages": [{"role": "user", "content": "hello"}],
    })
    assert res.status_code == 400
    assert "No API key" in res.json()["detail"]


def test_chat_streams_events(client):
    """Test that cloud chat endpoint returns SSE-formatted ChatStreamEvents."""
    _push_key(client, "openai", "sk-test-key")

    # Build fake SSE lines that the adapter would receive from OpenAI
    fake_sse_lines = [
        'data: {"id":"x","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
        'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":5}}',
        "data: [DONE]",
    ]
    fake_body = "\n".join(fake_sse_lines) + "\n"

    # We mock at the adapter level for a cleaner test
    async def fake_openai_adapter(model, messages, temperature, max_tokens, top_p, api_key):
        from local_models.schemas import ChatStreamEvent
        yield ChatStreamEvent(token="Hello")
        yield ChatStreamEvent(done=True, finish_reason="stop", usage={"total_tokens": 5})

    with patch("cloud_providers.router.STREAM_ADAPTERS", {"openai": fake_openai_adapter}):
        res = client.post("/cloud/chat", json={
            "provider": "openai",
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}],
        })
        assert res.status_code == 200
        assert "text/event-stream" in res.headers.get("content-type", "")

        # Parse SSE events from response body
        events = []
        for line in res.text.strip().split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))

        assert len(events) == 2
        assert events[0]["token"] == "Hello"
        assert events[1]["done"] is True
        assert events[1]["finish_reason"] == "stop"


def test_chat_adapter_error_yields_error_event(client):
    """If the adapter raises, the router should yield an error ChatStreamEvent."""
    _push_key(client, "anthropic", "sk-ant-test")

    async def failing_adapter(model, messages, temperature, max_tokens, top_p, api_key):
        raise RuntimeError("connection reset")
        yield  # make it a generator  # noqa: E501

    with patch("cloud_providers.router.STREAM_ADAPTERS", {"anthropic": failing_adapter}):
        res = client.post("/cloud/chat", json={
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
            "messages": [{"role": "user", "content": "hi"}],
        })
        assert res.status_code == 200
        events = []
        for line in res.text.strip().split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))

        assert len(events) >= 1
        last = events[-1]
        assert last["done"] is True
        assert last["finish_reason"] == "error"
