"""Inference engine wrapping llama-cpp-python."""

from __future__ import annotations

import asyncio
import gc
import logging
from typing import Any, AsyncGenerator

from .schemas import ChatStreamEvent, EngineStatusResponse

log = logging.getLogger(__name__)


class InferenceEngine:
    """Singleton wrapping a single loaded llama-cpp-python model."""

    def __init__(self) -> None:
        self._model: Any = None
        self._model_id: str | None = None
        self._loading: bool = False
        self._load_lock = asyncio.Lock()
        self._error: str | None = None

    @property
    def loaded_model_id(self) -> str | None:
        return self._model_id

    @property
    def is_ready(self) -> bool:
        return self._model is not None and not self._loading

    def status(self) -> EngineStatusResponse:
        if self._loading:
            state = "loading"
        elif self._model is not None:
            state = "ready"
        elif self._error:
            state = "error"
        else:
            state = "idle"
        return EngineStatusResponse(
            state=state,
            loaded_model_id=self._model_id,
            error=self._error,
        )

    async def load_model(
        self,
        model_id: str,
        model_path: str,
        n_ctx: int = 8192,
        n_gpu_layers: int = -1,
    ) -> None:
        """Load a GGUF model. Unloads any currently loaded model first."""
        async with self._load_lock:
            self._loading = True
            self._error = None
            try:
                # Unload current model
                if self._model is not None:
                    await self._do_unload()

                # Load in executor to avoid blocking the event loop
                loop = asyncio.get_event_loop()
                self._model = await loop.run_in_executor(
                    None,
                    self._load_sync,
                    model_path,
                    n_ctx,
                    n_gpu_layers,
                )
                self._model_id = model_id
            except Exception as e:
                self._model = None
                self._model_id = None
                self._error = str(e)
                raise
            finally:
                self._loading = False

    def _load_sync(self, model_path: str, n_ctx: int, n_gpu_layers: int) -> Any:
        """Synchronous model loading (runs in thread pool)."""
        from llama_cpp import Llama

        return Llama(
            model_path=model_path,
            n_ctx=n_ctx,
            n_gpu_layers=n_gpu_layers,
            verbose=False,
        )

    async def unload_model(self) -> None:
        """Unload the current model and free memory."""
        async with self._load_lock:
            await self._do_unload()

    async def _do_unload(self) -> None:
        if self._model is not None:
            del self._model
            self._model = None
            self._model_id = None
            gc.collect()

    async def generate_stream(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 4096,
        top_p: float = 0.95,
        tools: list[dict] | None = None,
    ) -> AsyncGenerator[ChatStreamEvent, None]:
        """Stream chat completions, yielding token events."""
        if self._model is None:
            raise RuntimeError("No model loaded")

        loop = asyncio.get_event_loop()

        # Run the blocking generator in a thread via queue
        queue: asyncio.Queue[ChatStreamEvent | None] = asyncio.Queue()

        def _run_inference() -> None:
            try:
                log.info("Starting inference with %d messages", len(messages))

                # Build kwargs
                kwargs: dict = {
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "top_p": top_p,
                    "stream": True,
                }

                # Add tools if provided (for tool-capable models)
                if tools:
                    # Convert to llama-cpp format
                    llama_tools = []
                    for t in tools:
                        llama_tools.append({
                            "type": "function",
                            "function": {
                                "name": t["name"],
                                "description": t.get("description", ""),
                                "parameters": t.get("parameters", {}),
                            },
                        })
                    kwargs["tools"] = llama_tools

                response = self._model.create_chat_completion(**kwargs)

                token_count = 0
                pending_tool_calls: dict[int, dict] = {}

                for chunk in response:
                    choice = chunk.get("choices", [{}])[0]
                    delta = choice.get("delta", {})
                    content = delta.get("content")
                    finish_reason = choice.get("finish_reason")

                    if content:
                        token_count += 1
                        loop.call_soon_threadsafe(
                            queue.put_nowait,
                            ChatStreamEvent(token=content),
                        )

                    # Handle tool call deltas
                    delta_tool_calls = delta.get("tool_calls")
                    if delta_tool_calls:
                        for tc_delta in delta_tool_calls:
                            idx = tc_delta.get("index", 0)
                            if idx not in pending_tool_calls:
                                pending_tool_calls[idx] = {"id": "", "name": "", "arguments": ""}
                            if tc_delta.get("id"):
                                pending_tool_calls[idx]["id"] = tc_delta["id"]
                            func = tc_delta.get("function", {})
                            if func.get("name"):
                                pending_tool_calls[idx]["name"] = func["name"]
                            if func.get("arguments"):
                                pending_tool_calls[idx]["arguments"] += func["arguments"]

                    if finish_reason:
                        # Emit tool calls if any
                        if pending_tool_calls:
                            calls = []
                            for _idx, tc in sorted(pending_tool_calls.items()):
                                calls.append({
                                    "id": tc.get("id", ""),
                                    "name": tc.get("name", ""),
                                    "arguments": tc.get("arguments", ""),
                                })
                            loop.call_soon_threadsafe(
                                queue.put_nowait,
                                ChatStreamEvent(tool_calls=calls),
                            )
                            pending_tool_calls.clear()

                        usage = chunk.get("usage")
                        loop.call_soon_threadsafe(
                            queue.put_nowait,
                            ChatStreamEvent(
                                done=True,
                                finish_reason=finish_reason,
                                usage=usage,
                            ),
                        )

                log.info("Inference complete: %d tokens generated", token_count)

                # If no done event was sent (model ended without finish_reason),
                # send one now so the client knows the stream is over
                if token_count == 0:
                    loop.call_soon_threadsafe(
                        queue.put_nowait,
                        ChatStreamEvent(done=True, finish_reason="stop", usage=None),
                    )

                # Sentinel
                loop.call_soon_threadsafe(queue.put_nowait, None)

            except Exception as e:
                log.error("Inference error: %s", e, exc_info=True)
                # Send error as a token so the user sees it
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    ChatStreamEvent(token=f"\n\n[Error: {e}]"),
                )
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    ChatStreamEvent(done=True, finish_reason="error", usage=None),
                )
                loop.call_soon_threadsafe(queue.put_nowait, None)

        loop.run_in_executor(None, _run_inference)

        while True:
            event = await queue.get()
            if event is None:
                break
            yield event
