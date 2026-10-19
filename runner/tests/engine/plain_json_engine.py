# SPDX-License-Identifier: Apache-2.0

"""The adapter prototype of the plain-JSON finalization spike (#547).

`PlainJsonEngine` is the stock `DynamicEngine` with the turn logic swapped, which is what #552
changes in the adapter: the same start, session, watch loop, limits and clean-up, but

- the message carries no `format` (`PlainJsonClient.send_message`), so the engine registers no
  `StructuredOutput` tool and sends no forced `tool_choice`;
- the review is the text of the message that ended the turn (`plain_json_final.extract_final_json`),
  validated by `parse_dynamic_findings` with the runner setting `schemaVersion` and `reviewedSha`;
- an answer that is not the review gets exactly one repair message in the same session;
- a cost or time limit that is near is announced to the model by one more user message sent while
  the turn runs (`prompt_async`), not by rewriting a request. The ledger stays the hard limit.

Test support, not production code: nothing in `src/` imports it.
"""

import json
import threading
from decimal import Decimal
from typing import Any

from opencode_support import ScriptedModel
from plain_json_final import (
    FINISH_NOW_INSTRUCTION,
    Problem,
    extract_final_json,
    final_answer_line,
    repair_message,
)

from code_reviewer_runner.dynamic_findings import (
    DynamicFindings,
    EnvelopeError,
)
from code_reviewer_runner.dynamic_review.adapter import (
    MAX_TURN_TIMEOUT_SECONDS,
    REASON_TURN_TIMEOUT,
    REVIEW_AGENT,
    SESSION_TIMEOUT_SECONDS,
    DynamicEngine,
    EngineAnswer,
    EngineClient,
    EngineError,
    EngineTimeout,
    turn_end_note,
)
from code_reviewer_runner.dynamic_review.config import PROXY_PROVIDER_ID
from code_reviewer_runner.dynamic_review.prompts import compose_user_prompt
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

# How often the watch for a near limit looks at the ledger (the adapter's own watch uses 0.05 s).
STEER_INTERVAL_SECONDS = 0.02
STOPPED_EARLY_COST = "cost_limit"
STOPPED_EARLY_TIME = "time_limit"


class ByRequestModel(ScriptedModel):
    """A scripted provider whose step `i` answers request `i`, whatever tools the request offers.

    The wrap-up of the tool-based path changes what a request offers; the plain-JSON path never
    does, so the script is a plain list of replies in the order the engine asks.
    """

    def answer(self, body: dict[str, Any]) -> dict[str, Any]:
        index = len(self.requests) - 1
        if index >= len(self.steps):
            reply: dict[str, Any] = {"role": "assistant", "content": "the script ran out"}
        else:
            step = self.steps[index]
            reply = step(body) if callable(step) else step
        message = dict(reply)
        finish = message.pop("finish_reason", None) or (
            "tool_calls" if message.get("tool_calls") else "stop"
        )
        usage: dict[str, Any] = {"prompt_tokens": 50, "completion_tokens": 10}
        if self.cost is not None:
            usage["cost"] = self.cost
        return {
            "id": "chatcmpl-test",
            "choices": [{"message": message, "finish_reason": finish}],
            "usage": usage,
        }


class PlainJsonClient(EngineClient):
    """The session API as the plain-JSON path uses it: no `format`, optionally a `tools` map."""

    # The `tools` map of the next message (`{"read": False, ...}`); None sends none.
    tools: dict[str, bool] | None = None

    def _body(self, model: str, parts: list[dict[str, str]]) -> dict[str, Any]:
        body: dict[str, Any] = {
            "agent": REVIEW_AGENT,
            "model": {"providerID": PROXY_PROVIDER_ID, "modelID": model},
            "parts": parts,
        }
        if self.tools is not None:
            body["tools"] = self.tools
        return body

    def send_message(
        self,
        session_id: str,
        *,
        model: str,
        parts: list[dict[str, str]],
        schema: Any,
        timeout: float = MAX_TURN_TIMEOUT_SECONDS,
    ) -> None:
        """One turn without `format`. `schema` is part of the signature of the stock client and is
        not sent."""
        try:
            status, answer = self._call(
                "POST",
                f"/session/{session_id}/message",
                self._body(model, parts),
                timeout=timeout,
            )
        except EngineTimeout:
            raise EngineTimeout(f"{REASON_TURN_TIMEOUT}: the turn did not finish in time") from None
        if status != 200:
            raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not answer")
        self.last_message = answer

    def queue_message(self, session_id: str, *, model: str, text: str) -> bool:
        """Add a user message to a turn that is running (`prompt_async`, 204): the engine reads it
        before its next step. True when the engine accepted it."""
        status, _ = self._call(
            "POST",
            f"/session/{session_id}/prompt_async",
            self._body(model, [{"type": "text", "text": text}]),
            timeout=SESSION_TIMEOUT_SECONDS,
        )
        return status == 204

    def holds_user_message(self, session_id: str, text: str) -> bool:
        """True when the session stores a user message with exactly this text. The pinned engine
        can list a session without a stored JSON-schema format (it cannot with one, #85)."""
        status, body = self._call(
            "GET", f"/session/{session_id}/message", timeout=SESSION_TIMEOUT_SECONDS
        )
        if status != 200:
            return False
        listed: Any = json.loads(body)
        if not isinstance(listed, list):
            return False
        entries: list[Any] = listed  # pyright: ignore[reportUnknownVariableType]
        for entry in entries:
            message = as_object(entry)
            info = as_object(message.get("info")) if message else None
            if info is None or info.get("role") != "user":
                continue
            parts: Any = message.get("parts") if message else None
            if not isinstance(parts, list):
                continue
            blocks: list[Any] = parts  # pyright: ignore[reportUnknownVariableType]
            if any((block := as_object(part)) and block.get("text") == text for part in blocks):
                return True
        return False


class _Verdict:
    """The message that ended a turn is not the review: the class and what to tell the model."""

    def __init__(self, problem: Problem, detail: str = "") -> None:
        self.problem = problem
        self.detail = detail


class PlainJsonEngine(DynamicEngine):
    """A Dynamic Review that ends as JSON text. See the module docstring."""

    def __init__(
        self,
        *args: Any,
        soft_cost_usd: Decimal | None = None,
        soft_seconds: float | None = None,
        forbid_tools_on_repair: bool = False,
        announced: threading.Event | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        # A limit is announced when this much is spent, or this little time is left.
        self.soft_cost_usd = soft_cost_usd
        self.soft_seconds = soft_seconds
        # Send the `tools` map that forbids every tool with the repair message (T04 variant).
        self.forbid_tools_on_repair = forbid_tools_on_repair
        # Set once the finish-now message was sent (a test holds a provider answer until then).
        self.announced = announced if announced is not None else threading.Event()
        # Why the model was asked to answer now, and whether the engine stored that message.
        self.wrap_up_reason: str | None = None
        self.wrap_up_stored = False
        # The class of the first answer when it was repaired.
        self.repaired: Problem | None = None

    def start(self) -> EngineClient:
        client = super().start()
        return PlainJsonClient(client.base_url, client.directory, transport=self._transport)

    # -- the turn -------------------------------------------------------------

    def _turns(self, client: EngineClient, session_id: str) -> EngineAnswer:
        assert isinstance(client, PlainJsonClient)
        self._send(client, session_id)
        self._raise_recorded_failure()
        failed = self._engine_error(client)
        if failed is not None:
            return failed
        first = self._judge(client)
        if isinstance(first, DynamicFindings):
            return EngineAnswer(findings=first, error=None)
        self.repaired = first.problem
        max_findings = self._max_findings()
        repair = repair_message(first.problem, first.detail, max_findings)
        if self.forbid_tools_on_repair:
            client.tools = {"read": False, "grep": False, "glob": False}
        self._send(client, session_id, prompt=repair)
        self._raise_recorded_failure()
        failed = self._engine_error(client)
        if failed is not None:
            return failed
        second = self._judge(client)
        if isinstance(second, DynamicFindings):
            return EngineAnswer(findings=second, error=None)
        note = f"after one repair; the first message: {first.problem}; the repair: {second.problem}"
        if second.problem is Problem.ENVELOPE_INVALID:
            raise EnvelopeError(ErrorCode.DYNAMIC_POLICY_VIOLATION, f"{note}; {second.detail}")
        return self._no_answer(note)

    def _max_findings(self) -> int:
        dynamic = self.job.dynamic
        assert dynamic is not None
        return dynamic.limits.max_findings

    def _engine_error(self, client: PlainJsonClient) -> EngineAnswer | None:
        """The engine's own error ends the run: there is no answer to repair (as in #309)."""
        note = turn_end_note(client.last_message)
        if "error=" not in note:
            return None
        return self._no_answer(f"the engine's own error, not repaired: {note}")

    def _judge(self, client: PlainJsonClient) -> DynamicFindings | _Verdict:
        document: Any = json.loads(client.last_message)
        message = as_object(document)
        extraction = extract_final_json(message if message is not None else {})
        if extraction.document is None:
            assert extraction.problem is not None
            return _Verdict(extraction.problem, extraction.detail)
        base = self.job.base
        assert base is not None
        try:
            findings = _parse(extraction.document, self, base.head_sha)
        except EnvelopeError as error:
            return _Verdict(Problem.ENVELOPE_INVALID, error.detail)
        if len(findings.findings) > self._max_findings():
            return _Verdict(Problem.TOO_MANY_FINDINGS)
        return findings

    # -- the message that goes with the first turn, and the watch for a near limit ----------

    def _send(self, client: EngineClient, session_id: str, *, prompt: str | None = None) -> None:
        assert isinstance(client, PlainJsonClient)
        if prompt is None:
            prompt = compose_user_prompt(self.inputs) + final_answer_line(self._max_findings())
            prompt += "\n"
            self.ledger.check_input_bytes(len(prompt.encode("utf-8")))
        stop = threading.Event()
        watch = threading.Thread(
            target=self._announce, args=(client, session_id, stop), daemon=True
        )
        watch.start()
        try:
            super()._send(client, session_id, prompt=prompt)
        finally:
            stop.set()
            watch.join(timeout=5.0)
            client.tools = None

    def _soft_limit(self) -> str | None:
        if self.soft_seconds is not None and self.ledger.remaining_seconds() <= self.soft_seconds:
            return STOPPED_EARLY_TIME
        cost = self.ledger.usage(None).cost_usd
        if (
            self.soft_cost_usd is not None
            and cost is not None
            and Decimal(str(cost)) >= self.soft_cost_usd
        ):
            return STOPPED_EARLY_COST
        return None

    def _announce(self, client: PlainJsonClient, session_id: str, stop: threading.Event) -> None:
        """Once per run: when a limit is near, add the finish-now message to the running turn."""
        dynamic = self.job.dynamic
        assert dynamic is not None
        while not stop.wait(STEER_INTERVAL_SECONDS):
            if self.wrap_up_reason is not None:
                return
            reason = self._soft_limit()
            if reason is None:
                continue
            self.wrap_up_reason = reason
            try:
                if client.queue_message(
                    session_id, model=dynamic.model, text=FINISH_NOW_INSTRUCTION
                ):
                    self.wrap_up_stored = client.holds_user_message(
                        session_id, FINISH_NOW_INSTRUCTION
                    )
            finally:
                self.announced.set()
            return


def _parse(document: dict[str, Any], engine: PlainJsonEngine, head_sha: str) -> DynamicFindings:
    from code_reviewer_runner.dynamic_findings import parse_dynamic_findings

    return parse_dynamic_findings(
        document, exported_paths=engine.exported_paths, reviewed_sha=head_sha
    )
