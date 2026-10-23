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
   cache prefix and the binding of thinking blocks stay valid. The announcement is best effort: one
   the engine cannot take is "not announced" and not a failure, and the end of a turn waits for a
   running one, so none reaches the engine after the abort and the mark.
4. **A run never ends without a review because of the cost guard** (#540). A model that ignores the
   message meets the ledger's refusal of its next call (`RefusedForFinal`, which is not the run's
   failure; the watch and the reading of a turn react only to a refusal *counted during that
   turn*). The turn ends; the adapter aborts the session, waits until the proxy and the ledger have
   nothing in flight, marks the next call as final (`arm_final`, with the exact text) and sends one
   "answer now" message, which the ledger admits past the limit. A mark the turn did not use gets
   the message once more, once. A refusal in that turn is a tool call when the audit saw one, and
   otherwise a class of its own, and is followed by the one repair. The overshoot is the bound of
   #542: the limit, the excess of the last normal call, the final call and the repair.

A failure the ledger recorded (a limit, a policy violation, a provider refusal, the tool-result
audit) always wins over whatever message the turn left. The engine's own error is not an answer and
is not repaired; its text is never shown, only its name as an identifier and the stable code the
proxy kept for a provider that failed.
"""

import json
import secrets
import threading
import time
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
    final_message,
    repair_message,
    validator_detail,
)
from code_reviewer_runner.dynamic_review.finalization_log import FinalizationRecord
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

# How often the watch looks at the ledger while a turn runs (the adapter's own watch is 50 ms too).
WATCH_INTERVAL_SECONDS: Final = 0.05
# The announcement is one call to the engine with this timeout. The end of a turn waits for it (a
# little longer), so no announcement can reach the engine after the abort and the mark.
ANNOUNCE_TIMEOUT_SECONDS: Final = 10.0
_JOIN_SECONDS: Final = ANNOUNCE_TIMEOUT_SECONDS + 5.0
# The longest the adapter waits for the proxy to answer the aborted turn's last call before it
# marks the next one (and never longer than what is left of the job).
IDLE_WAIT_SECONDS: Final = 30.0


class NoFinalAnswer(Exception):
    """The run ended without a review the model could be asked for again. `note` holds stable
    classes and identifiers only; the adapter turns it into `llm_output_invalid`."""

    def __init__(self, note: str) -> None:
        super().__init__(note)
        self.note = note


class FinalClient(Protocol):
    """The part of the session API the finalization uses."""

    last_message: bytes

    def queue_message(self, session_id: str, *, model: str, text: str, timeout: float) -> bool: ...

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
        wait_idle: Callable[[float], bool] = lambda _timeout: True,
        new_token: Callable[[], str] = lambda: secrets.token_hex(16),
    ) -> None:
        self._client = client
        self._session = session_id
        self._ledger = ledger
        self._send = send
        self._model = model
        self._max_findings = max_findings
        self._parse = parse
        self._provider_error = provider_error
        # Whether the proxy has answered every request it took (the ledger's own view of its open
        # calls is waited for as well, `BudgetLedger.wait_idle`).
        self._wait_idle = wait_idle
        # A fresh random token for each message that asks for the answer (the mark is bound to it).
        self._new_token = new_token
        self._announced = False
        # The announcement of the running turn: its reason once the engine accepted it, and whether
        # that was after the turn had ended.
        self._accepted: str | None = None
        self._turn_over = threading.Event()
        self._watch_error: Exception | None = None
        # What the ledger counted when the running turn started: only an increase is this turn's.
        self._refusals_before = 0
        self._tool_calls_before = 0
        # How the review was ended, for the one log line of the run (`finalization_log.py`).
        self.record = FinalizationRecord()

    def run(self) -> DynamicFindings:
        """The review, or an exception: `NoFinalAnswer`, `EnvelopeError`, `LimitError`."""
        self._turn(None)
        outcome = self._read()
        if outcome is None:
            # The guard refused a call: the agent phase is over, the answer is still owed. The run
            # stopped early now: the adapter acts on the refusal (and on no other).
            self._ledger.note_wrap_up(
                self._ledger.refusal_reason or self._ledger.limits.cost_stop_reason
            )
            self.record.final_call = "exempt"
            self._ask(final_message, abort=True)
            outcome = self._read() or self._after_the_final_call()
        if isinstance(outcome, DynamicFindings):
            return outcome
        self.record.first = outcome.problem.value
        return self._repair(outcome)

    def _repair(self, first: _Verdict) -> DynamicFindings:
        """The one repair. A second failure ends the run; there is no third message."""
        self._ask(
            lambda token: repair_message(first.problem, first.detail, self._max_findings, token),
            abort=False,
        )
        self.record.repaired = True
        second = self._read() or self._after_the_final_call()
        if isinstance(second, DynamicFindings):
            self.record.second = "ok"
            return second
        self.record.second = second.problem.value
        note = f"after one repair; the first message: {first.problem}; the repair: {second.problem}"
        if second.problem is Problem.ENVELOPE_INVALID:
            raise EnvelopeError(ErrorCode.DYNAMIC_POLICY_VIOLATION, f"{note}; {second.detail}")
        raise NoFinalAnswer(note)

    def _after_the_final_call(self) -> _Verdict:
        """The guard refused a call in the turn of the final call. When the audit saw the model
        ask for a tool in that turn, that is what happened; otherwise the engine asked again for
        another reason (a retry, a hidden call), and the model is not told it called a tool."""
        if self._ledger.tool_calls > self._tool_calls_before:
            return _Verdict(Problem.TOOL_CALL)
        return _Verdict(Problem.FINAL_CALL_REFUSED)

    def _ask(self, build: Callable[[str], str], *, abort: bool = True) -> None:
        """Send one runner message as a call the ledger admits past the limit. Aborting first
        makes sure no step of the earlier turn is still running when the mark is set, and the
        proxy is given the time to answer the call the abort cut short: the mark needs nothing in
        flight."""
        if abort:
            self._client.abort(self._session)
        self._settle()
        token = self._new_token()
        text = build(token)
        if not self._ledger.arm_final(text, token):
            raise self._ledger.final_refusal()
        self._turn(text)
        if not self._ledger.final_armed:
            return
        # The engine made no call for the message (the session was still winding down after the
        # abort): the mark is unused, so the message goes out once more, and only once.
        self._turn(text)
        if self._ledger.final_armed:
            raise NoFinalAnswer(
                "the engine made no model call for the message that asks for the answer"
            )

    def _settle(self) -> None:
        """Wait, within the job's deadline, until nothing of the aborted turn is in flight."""
        wait = min(self._ledger.remaining_seconds(), IDLE_WAIT_SECONDS)
        started = time.monotonic()
        self._wait_idle(wait)
        self._ledger.wait_idle(max(wait - (time.monotonic() - started), 0.0))

    def _turn(self, prompt: str | None) -> None:
        self._refusals_before = self._ledger.refusals
        self._tool_calls_before = self._ledger.tool_calls
        self._accepted = None
        self._turn_over.clear()
        stop = threading.Event()
        watch = threading.Thread(target=self._watch, args=(stop,), daemon=True)
        watch.start()
        try:
            self._send(prompt)
        finally:
            self._turn_over.set()
            stop.set()
            watch.join(timeout=_JOIN_SECONDS)
        if watch.is_alive():
            # An announcement that is still on its way could start a turn of its own after the
            # abort and the mark: fail closed instead of marking around it.
            raise LimitError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not take the announcement"
            )
        if self._watch_error is not None:
            raise self._watch_error
        if self._accepted is not None and self._ledger.refusals == self._refusals_before:
            # The engine took an announcement and nothing followed that the adapter acts on: an
            # announcement it took after the turn ended would start a turn of its own, with a model
            # call nobody asked for, after the review is read. Nothing of this turn may be left.
            self._client.abort(self._session)
            self._settle()

    # -- the answer -----------------------------------------------------------

    def _read(self) -> DynamicFindings | _Verdict | None:
        """What the turn that just ended left: the review, why it is not one, or None when the
        guard refused a call in it (the turn ended without an answer to read). A valid review in
        the last message wins over a refusal: a hidden call of the engine can be refused while the
        turn itself ended well."""
        failure = self._ledger.failure
        if failure is not None:
            raise failure
        if self._ledger.refusals > self._refusals_before:
            outcome = self._review_of(_document(self._client.last_message))
            return outcome if isinstance(outcome, DynamicFindings) else None
        return self._judge()

    def _judge(self) -> DynamicFindings | _Verdict:
        document = _document(self._client.last_message)
        named = engine_error_name(document)
        if named is not None:
            code = self._provider_error()
            if code is not None:
                raise LimitError(code, "the model provider failed and the engine gave up")
            raise NoFinalAnswer(f"the engine's own error, not repaired (error={named})")
        return self._review_of(document)

    def _review_of(self, document: dict[str, Any]) -> DynamicFindings | _Verdict:
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
                if self._ledger.refusals > self._refusals_before and not self._ledger.final_armed:
                    # The guard refused a call in this turn: the engine's turn ends by itself, but
                    # an engine that does not must not hold the run until its deadline. (A mark
                    # that is still armed means the call for the answer has not been made yet; a
                    # refusal then is a stray one and the turn is the one to wait for.)
                    self._client.abort(self._session)
                    return
                if self._announced:
                    continue
                reason = self._ledger.wrap_up_due()
                if reason is None:
                    continue
                self._announced = True
                self._announce(reason)
        except Exception as error:  # re-raised in the caller's thread, after the join
            self._watch_error = error

    def _announce(self, reason: str) -> None:
        """Ask the model to answer, by one more message. Best effort: an engine that cannot take
        it (or does not answer in time) leaves the model unasked, which only means the guard's
        refusal comes first. The run is not failed for it, and the reason is recorded only for an
        announcement that was made."""
        try:
            accepted = self._client.queue_message(
                self._session,
                model=self._model,
                text=FINISH_NOW_INSTRUCTION,
                timeout=ANNOUNCE_TIMEOUT_SECONDS,
            )
        except Exception:  # whatever the transport made of it: not announced
            return
        if not accepted:
            return
        self._accepted = reason
        if not self._turn_over.is_set():
            # The model could see it: that is why the run stopped early. One the engine took only
            # after the turn had ended asked nobody (and is aborted at the end of the turn).
            self._ledger.note_wrap_up(reason)


def _document(message: bytes) -> dict[str, Any]:
    try:
        value: Any = json.loads(message)
    except (ValueError, RecursionError):
        return {}
    return as_object(value) or {}
