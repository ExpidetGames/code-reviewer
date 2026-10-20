# SPDX-License-Identifier: Apache-2.0

"""The turns of a Dynamic Review that ends as plain JSON text (#552, spike #547).

On the native path the engine is given no `format`: there is no `StructuredOutput` tool, no forced
tool choice, and the proxy rewrites nothing. The review is the text of the message that ended the
turn, and everything the wire used to decide is decided here, above it:

1. The first turn runs. The review is read from the **last assistant message** only
   (`final_json.extract_final_json`), checked by the envelope check (`parse_dynamic_findings`; the
   runner sets `schemaVersion` and `reviewedSha` itself, #530) and bounded by the job's finding
   count.
2. An answer that is not the review gets **exactly one** repair: one user message that names the
   class of the problem (`final_messages.repair_message`: a stable class, field names of the
   validator, never what the model or the pull request wrote). The repair is a model call the
   ledger marks (`arm_final`), reserves and settles like any other. A second failure ends the run
   with the codes of today: `dynamic_policy_violation` for an invalid envelope, `llm_output_invalid`
   otherwise.
3. **The limits are announced, not enforced by a rewrite.** While a turn runs, a watch asks the
   ledger whether the answer is due (`wrap_up_due`: the cost arithmetic of the wrap-up, and the
   clock a little before its reserve) and adds one user message to the running turn
   (`prompt_async`), once. The tools, the tool choice and the system prompt are untouched, so the
   cache prefix and the binding of thinking blocks stay valid.
4. **A run never ends without a review because of the cost guard** (#540). A model that ignores the
   message meets the ledger's refusal of its next call (`RefusedForFinal`, which is not the run's
   failure). The turn ends; the adapter aborts the session, marks the next call as final
   (`arm_final`) and sends one "answer now" message, which the ledger admits past the limit. A tool
   call in that turn is refused again and followed by the one repair (class `tool_call`), not by a
   silent failure. The overshoot is the bound of #542: the limit, the excess of the last normal
   call, the final call and the repair.

A failure the ledger recorded (a limit, a policy violation, a provider refusal, the tool-result
audit) always wins over whatever message the turn left. The engine's own error is not an answer and
is not repaired; its text is never shown, only its name as an identifier and the stable code the
proxy kept for a provider that failed.
"""

import json
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final, Protocol

from code_reviewer_runner.dynamic_findings import DynamicFindings, EnvelopeError, FindingsError
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError
from code_reviewer_runner.dynamic_review.final_json import (
    Problem,
    engine_error_name,
    extract_final_json,
)
from code_reviewer_runner.dynamic_review.final_messages import (
    FINISH_NOW_INSTRUCTION,
    repair_message,
    validator_detail,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

# How often the watch looks at the ledger while a turn runs (the adapter's own watch is 50 ms too).
WATCH_INTERVAL_SECONDS: Final = 0.05
_JOIN_SECONDS: Final = 5.0


class NoFinalAnswer(Exception):
    """The run ended without a review the model could be asked for again. `note` holds stable
    classes and identifiers only; the adapter turns it into `llm_output_invalid`."""

    def __init__(self, note: str) -> None:
        super().__init__(note)
        self.note = note


class FinalClient(Protocol):
    """The part of the session API the finalization uses."""

    last_message: bytes

    def queue_message(self, session_id: str, *, model: str, text: str) -> bool: ...

    def abort(self, session_id: str) -> None: ...


@dataclass(frozen=True)
class _Verdict:
    """The message that ended a turn is not the review: the class and what to tell the model."""

    problem: Problem
    detail: str = ""


class PlainFinalization:
    """Runs the turns of one review until it has an answer. One instance per run."""

    def __init__(
        self,
        *,
        client: FinalClient,
        session_id: str,
        ledger: BudgetLedger,
        send: Callable[[str | None], None],
        model: str,
        max_findings: int,
        parse: Callable[[dict[str, Any]], DynamicFindings],
        provider_error: Callable[[], ErrorCode | None] = lambda: None,
    ) -> None:
        self._client = client
        self._session = session_id
        self._ledger = ledger
        self._send = send
        self._model = model
        self._max_findings = max_findings
        self._parse = parse
        self._provider_error = provider_error
        self._announced = False
        self._watch_error: Exception | None = None

    def run(self) -> DynamicFindings:
        """The review, or an exception: `NoFinalAnswer`, `EnvelopeError`, `LimitError`."""
        self._turn(None)
        outcome = self._read()
        if outcome is None:
            # The guard refused a call: the agent phase is over, the answer is still owed.
            self._ask(FINISH_NOW_INSTRUCTION, abort=True)
            outcome = self._read() or _Verdict(Problem.TOOL_CALL)
        if isinstance(outcome, DynamicFindings):
            return outcome
        return self._repair(outcome)

    def _repair(self, first: _Verdict) -> DynamicFindings:
        """The one repair. A second failure ends the run; there is no third message."""
        self._ask(repair_message(first.problem, first.detail, self._max_findings), abort=False)
        second = self._read() or _Verdict(Problem.TOOL_CALL)
        if isinstance(second, DynamicFindings):
            return second
        note = f"after one repair; the first message: {first.problem}; the repair: {second.problem}"
        if second.problem is Problem.ENVELOPE_INVALID:
            raise EnvelopeError(ErrorCode.DYNAMIC_POLICY_VIOLATION, f"{note}; {second.detail}")
        raise NoFinalAnswer(note)

    def _ask(self, text: str, *, abort: bool = True) -> None:
        """Send one runner message as a call the ledger admits past the limit. Aborting first
        makes sure no step of the earlier turn is still running when the mark is set."""
        if abort:
            self._client.abort(self._session)
        if not self._ledger.arm_final(text):
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED, "no call was left for the answer to the run"
            )
        self._announced = True
        self._turn(text)

    def _turn(self, prompt: str | None) -> None:
        stop = threading.Event()
        watch = threading.Thread(target=self._watch, args=(stop,), daemon=True)
        watch.start()
        try:
            self._send(prompt)
        finally:
            stop.set()
            watch.join(timeout=_JOIN_SECONDS)
        if self._watch_error is not None:
            raise self._watch_error

    # -- the answer -----------------------------------------------------------

    def _read(self) -> DynamicFindings | _Verdict | None:
        """What the turn that just ended left: the review, why it is not one, or None when the
        guard refused a call (the turn ended without an answer to read)."""
        failure = self._ledger.failure
        if failure is not None:
            raise failure
        if self._ledger.take_refusal():
            return None
        return self._judge()

    def _judge(self) -> DynamicFindings | _Verdict:
        document = _document(self._client.last_message)
        named = engine_error_name(document)
        if named is not None:
            code = self._provider_error()
            if code is not None:
                raise LimitError(code, "the model provider failed and the engine gave up")
            raise NoFinalAnswer(f"the engine's own error, not repaired (error={named})")
        extraction = extract_final_json(document)
        if extraction.document is None:
            assert extraction.problem is not None
            return _Verdict(extraction.problem, extraction.detail)
        try:
            findings = self._parse(extraction.document)
        except FindingsError as error:
            # Not only the envelope: findings that are all invalid are the model's mistake too, and
            # exactly as repairable. The detail names our fields, never a name the model chose.
            return _Verdict(Problem.ENVELOPE_INVALID, validator_detail(error.detail))
        if len(findings.findings) > self._max_findings:
            return _Verdict(Problem.TOO_MANY_FINDINGS)
        return findings

    # -- the watch ------------------------------------------------------------

    def _watch(self, stop: threading.Event) -> None:
        try:
            while not stop.wait(WATCH_INTERVAL_SECONDS):
                if self._ledger.refusal_pending:
                    # The guard refused a call: the engine's turn ends by itself, but an engine
                    # that does not must not hold the run until its deadline.
                    self._client.abort(self._session)
                    return
                if self._announced:
                    continue
                reason = self._ledger.wrap_up_due()
                if reason is None:
                    continue
                self._announced = True
                self._ledger.note_wrap_up(reason)
                self._client.queue_message(
                    self._session, model=self._model, text=FINISH_NOW_INSTRUCTION
                )
        except Exception as error:  # re-raised in the caller's thread, after the join
            self._watch_error = error


def _document(message: bytes) -> dict[str, Any]:
    try:
        value: Any = json.loads(message)
    except (ValueError, RecursionError):
        return {}
    return as_object(value) or {}
