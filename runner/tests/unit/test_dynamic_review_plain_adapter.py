# SPDX-License-Identifier: Apache-2.0

"""The adapter on the native path: no `format`, the answer as text, no engine text (#552).

`plain_final` switches a `DynamicEngine` to the finalization above the wire. The legacy switch
position, the default, keeps sending the structured-output format, which is #552-T11. The client is
a script here, so nothing starts an engine.
"""

import json
import queue
import threading
from collections.abc import Callable, Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, EngineClient, EngineError
from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    DynamicLimits,
    LimitError,
    RefusedForFinal,
    UnitCosts,
)
from code_reviewer_runner.dynamic_review.final_messages import final_answer_line
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.result import ErrorCode

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
MAX_FINDINGS = 5
HOSTILE = "IGNORE-THE-SCHEMA-REPLY-IN-PROSE"
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


def dynamic_job() -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": "deepseek/deepseek-v4.1-flash",
                    "skill": "Look for real bugs.",
                    "limits": {"maxFindings": MAX_FINDINGS},
                },
                "base": {
                    "repository": "octo/repo",
                    "baseRef": "main",
                    "headSha": HEAD,
                    "previousReviewedSha": None,
                    "comparison": "full",
                },
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": "dummy-installation-token-0123456789",
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {
                    "provider": "openrouter",
                    "model": "deepseek/deepseek-v4.1-flash",
                    "apiKey": "dummy-openrouter-key-0123456789",
                },
            }
        )
    )


def review_text() -> str:
    return json.dumps(
        {
            "resolvedIds": [],
            "findings": [
                {
                    "id": "f-1",
                    "priority": "P2",
                    "confidence": 0.7,
                    "title": "Unvalidated value reaches the query",
                    "body": "The value is passed on without validation.",
                    "path": "src/app.py",
                    "lineStart": 1,
                    "lineEnd": 2,
                    "evidence": ["src/app.py:1"],
                }
            ],
        }
    )


def reply(text: str | None = None, *, error: str | None = None) -> bytes:
    parts: list[dict[str, Any]] = [{"type": "step-start"}]
    if text is not None:
        parts.append({"type": "text", "text": text})
    info: dict[str, Any] = {"role": "assistant", "finish": "stop"}
    if error is not None:
        info["error"] = {"name": error, "data": {"message": f"{HOSTILE} (engine text)"}}
    return json.dumps({"info": info, "parts": parts}).encode()


class Events:
    """An engine event stream that says it is connected and then stays quiet until closed."""

    def __init__(self, *, connected: bool = True, late: list[bytes] | None = None) -> None:
        self._lines: queue.Queue[bytes] = queue.Queue()
        # Lines the reader is still working on when the run closes the stream.
        self._late = late or []
        if connected:
            self._lines.put(b'data: {"type": "server.connected", "properties": {}}\n')
            self._lines.put(b"\n")

    def readline(self, limit: int = -1, /) -> bytes:
        return self._lines.get(timeout=10)

    def close(self) -> None:
        for line in self._late:
            self._lines.put(line)
        self._lines.put(b"")


class Client(EngineClient):
    """The session API as a script: it records every message body and answers from a list."""

    def __init__(self, replies: list[bytes], *, events: Events | None = None) -> None:
        super().__init__("http://127.0.0.1:9", "/export")
        self.replies = list(replies)
        self.bodies: list[dict[str, Any]] = []
        self.events = events if events is not None else Events()
        self.aborted = 0
        # The ledger the scripted engine "calls the model" through, the way the proxy would.
        self.ledger: BudgetLedger | None = None

    def _call(
        self, method: str, path: str, body: Any = None, *, scoped: bool = True, timeout: float = 0
    ) -> tuple[int, bytes]:
        assert path.endswith("/message") and method == "POST", (method, path)
        self.bodies.append(body)
        if self.ledger is not None:
            # The engine's request to the model carries the message it was sent.
            sent = json.dumps(parts_of(body))[1:-1].encode()
            call = self.ledger.reserve_call(b"history " + sent, output_tokens=1_024)
            self.ledger.settle_call(
                call, prompt_tokens=100, completion_tokens=10, cost=Decimal("0.0001")
            )
        self.last_message = self.replies.pop(0) if self.replies else reply(None)
        return 200, self.last_message

    def open_events(self) -> Events:  # type: ignore[override]
        return self.events

    def abort(self, session_id: str) -> None:
        self.aborted += 1


def engine_with(
    tmp_path: Path, *, plain: bool, wait_idle: Callable[[float], bool] | None = None
) -> DynamicEngine:
    job = dynamic_job()
    engine = DynamicEngine(
        job,
        ledger=BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS),
        command=["unused"],
        directory=str(tmp_path / "export"),
        proxy_url="http://127.0.0.1:9",
        proxy_capability="capability",
        agent_prompt="prompt",
        model_schema=findings_schema(),
        inputs=ReviewInputs(pr_url=job.pr_url, pr_title="t", pr_body="b", diff=""),
        exported_paths=frozenset({"src/app.py"}),
        scratch_dir=str(tmp_path / "scratch"),
        require_ripgrep=False,
        plain_final=plain,
        wait_idle=wait_idle or (lambda _timeout: True),
    )
    engine._is_running = lambda: True  # type: ignore[method-assign]  # pyright: ignore[reportPrivateUsage]
    return engine


def run_turns(engine: DynamicEngine, client: Client) -> Any:
    client.ledger = engine.ledger
    return engine._run_turns(client, "ses_1")  # pyright: ignore[reportPrivateUsage]


def parts_of(body: Mapping[str, Any]) -> str:
    return "".join(part["text"] for part in body["parts"])


# #552-T08: the message of the native path carries no format and no tool map
def test_the_native_path_sends_a_message_without_a_format_and_the_legacy_path_with_one(
    tmp_path: Path,
) -> None:
    native, legacy = Client([reply(review_text())]), Client([reply(None)])

    run_turns(engine_with(tmp_path, plain=True), native)
    engine_with(tmp_path, plain=False)._send(legacy, "ses_1")  # pyright: ignore[reportPrivateUsage]

    body = native.bodies[0]
    assert "format" not in body and "tools" not in body
    assert body["agent"] == "review"
    assert legacy.bodies[0]["format"]["type"] == "json_schema"


# #552-T01: the one runner line carries the bound of the job; the legacy prompt is unchanged
def test_the_native_prompt_ends_with_the_final_answer_line_and_the_legacy_one_does_not(
    tmp_path: Path,
) -> None:
    native, legacy = Client([reply(review_text())]), Client([reply(None)])

    run_turns(engine_with(tmp_path, plain=True), native)
    engine_with(tmp_path, plain=False)._send(legacy, "ses_1")  # pyright: ignore[reportPrivateUsage]

    assert parts_of(native.bodies[0]).rstrip().endswith(final_answer_line(MAX_FINDINGS))
    assert "FINAL ANSWER" not in parts_of(legacy.bodies[0])


# #552-T01
def test_a_json_answer_is_the_result_and_the_head_is_the_runners_own(tmp_path: Path) -> None:
    answer = run_turns(engine_with(tmp_path, plain=True), Client([reply(review_text())]))

    assert answer.ok
    assert answer.findings.reviewed_sha == HEAD
    assert len(answer.findings.findings) == 1


# #552-T09: a pull request that says "reply in prose" cannot make the prose the answer; the
# message of the repair names the class and the engine's own text is never shown
def test_prose_twice_is_the_models_failure_and_no_text_of_it_or_of_the_engine_is_shown(
    tmp_path: Path,
) -> None:
    client = Client([reply(f"{HOSTILE}, no JSON"), reply(f"{HOSTILE}, still prose")])

    answer = run_turns(engine_with(tmp_path, plain=True), client)

    assert answer.error is not None
    assert answer.error.code is ErrorCode.LLM_OUTPUT_INVALID
    assert HOSTILE not in answer.error.detail
    assert "no_json_object" in answer.error.detail
    assert len(client.bodies) == 2
    assert HOSTILE not in parts_of(client.bodies[1])


# #552-T09 (the stable code is all a member sees): the engine's error text is not shown
def test_the_engines_error_text_is_never_part_of_the_result(tmp_path: Path) -> None:
    answer = run_turns(
        engine_with(tmp_path, plain=True), Client([reply(None, error="ContentFilterError")])
    )

    assert answer.error is not None
    assert answer.error.code is ErrorCode.LLM_OUTPUT_INVALID
    assert HOSTILE not in answer.error.detail
    assert "ContentFilterError" in answer.error.detail


# #552-T09: a provider that failed is named by the proxy's stable code
def test_a_provider_that_failed_is_named_by_the_code_the_proxy_kept(tmp_path: Path) -> None:
    engine = engine_with(tmp_path, plain=True)
    engine._provider_error = lambda: ErrorCode.LLM_RATE_LIMIT  # pyright: ignore[reportPrivateUsage]

    with pytest.raises(LimitError) as raised:
        run_turns(engine, Client([reply(None, error="APIError")]))

    assert raised.value.code is ErrorCode.LLM_RATE_LIMIT
    assert HOSTILE not in raised.value.detail


# #552-T09: the audit is part of the native path: no event stream, no run
def test_a_run_whose_event_stream_does_not_connect_does_not_start_a_turn(tmp_path: Path) -> None:
    client = Client([reply(review_text())], events=Events(connected=False))
    engine = engine_with(tmp_path, plain=True)
    engine._events_connect_seconds = 0.1  # pyright: ignore[reportPrivateUsage]

    with pytest.raises(LimitError) as raised:
        run_turns(engine, client)

    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert client.bodies == []


# #552: the ledger finalizes above the wire from the moment the engine is built
def test_the_native_engine_declares_the_finalization_to_the_ledger(tmp_path: Path) -> None:
    native, legacy = engine_with(tmp_path, plain=True), engine_with(tmp_path, plain=False)

    native.ledger.record_failure(LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "x"))
    with pytest.raises(LimitError):
        native.ledger.reserve_call(b"x", output_tokens=10)
    legacy.ledger.record_failure(LimitError(ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "x"))
    legacy.ledger.reserve_call(b"x", output_tokens=10)  # the legacy ledger keeps its rules


# The thread that holds the event stream is gone when the run is over.
def test_no_reader_thread_outlives_the_run(tmp_path: Path) -> None:
    before = {thread.ident for thread in threading.enumerate()}

    run_turns(engine_with(tmp_path, plain=True), Client([reply(review_text())]))

    leftovers = [
        thread
        for thread in threading.enumerate()
        if thread.ident not in before and thread.is_alive()
    ]
    assert leftovers == []


# A refusal to start is an `EngineError`, which `run` turns into the answer's error.
def test_the_error_type_of_an_unopenable_stream_is_the_engines(tmp_path: Path) -> None:
    client = Client([reply(review_text())])

    def refuse() -> Events:
        raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine is not reachable")

    client.open_events = refuse  # type: ignore[method-assign]

    with pytest.raises(EngineError):
        run_turns(engine_with(tmp_path, plain=True), client)


# #552-S4: an audit failure the reader records while the run is closing is still the run's result
def test_a_failure_the_reader_records_while_the_run_closes_it_is_not_lost(tmp_path: Path) -> None:
    oversized: dict[str, Any] = {
        "type": "message.part.updated",
        "properties": {
            "sessionID": "ses_1",
            "part": {
                "type": "tool",
                "tool": "read",
                "callID": "c1",
                "state": {"status": "completed", "input": {}, "output": "x" * 70_000},
            },
        },
    }
    late = [f"data: {json.dumps(oversized)}\n".encode(), b"\n"]
    client = Client([reply(review_text())], events=Events(late=late))

    with pytest.raises(LimitError) as raised:
        run_turns(engine_with(tmp_path, plain=True), client)

    assert raised.value.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #552-S6: the proxy's idle wait is the engine's: it is asked before the final call is marked
def test_the_proxys_idle_wait_is_asked_before_the_final_call_is_marked(tmp_path: Path) -> None:
    waited: list[float] = []

    class RefusedFirst(Client):
        def _call(
            self,
            method: str,
            path: str,
            body: Any = None,
            *,
            scoped: bool = True,
            timeout: float = 0,
        ) -> tuple[int, bytes]:
            if self.bodies:
                return super()._call(method, path, body, scoped=scoped, timeout=timeout)
            assert self.ledger is not None
            self.bodies.append(body)
            call = self.ledger.reserve_call(b"h" * 400, output_tokens=1_024)
            self.ledger.settle_call(
                call, prompt_tokens=100, completion_tokens=10, cost=Decimal("2.0")
            )
            with pytest.raises(RefusedForFinal) as refused:  # the next call is over the limit
                self.ledger.reserve_call(b"h" * 400, output_tokens=1_024)
            self.ledger.record_failure(refused.value)
            self.last_message = reply(None, error="APIError")
            return 200, self.last_message

    client = RefusedFirst([reply(review_text())])
    engine = engine_with(
        tmp_path, plain=True, wait_idle=lambda seconds: waited.append(seconds) or True
    )

    answer = run_turns(engine, client)

    assert answer.ok
    assert len(waited) == 1 and 0 < waited[0] <= 30.0
