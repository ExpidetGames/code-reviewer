# SPDX-License-Identifier: Apache-2.0

"""The finalization line of a native run (#578; the format of the live checklist, spike #547 7.1).

One line per run, written by the supervisor: how the review was ended and what the last calls
cost in tokens. It holds stable names (`final_json.Problem`, the stop reasons of the ledger) and
numbers only; nothing the model, the repository or the pull request wrote. A run whose log has no
such line did not use the native path.

`first` is the class of the problem with the message that ended the turn (`ok` when it was the
review), `second` the same for the one repair (`none` when there was none). `final_call` is
`exempt` when the cost guard refused the next call and the adapter asked for the answer with the
call that the ledger admits past the limit (#542), `normal` when the model ended the turn itself.
The tokens come from the call trace of the ledger: the call that wrote the review, the repair call
after it, and the prompt of the call before them. A trace that was cut at its bound or is missing
leaves them out (`-`), never guessed.
"""

from dataclasses import dataclass
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object

_NONE = "-"


@dataclass
class FinalizationRecord:
    """What `PlainFinalization` did with the message that ended the turn."""

    first: str = "ok"
    repaired: bool = False
    second: str = "none"
    # `exempt` once the adapter asked for the answer after the guard refused a call.
    final_call: str = "normal"


def _calls(trace: dict[str, Any] | None) -> list[dict[str, Any]]:
    if trace is None or trace.get("truncated") is not False:
        return []
    items: Any = trace.get("modelCalls")
    if not isinstance(items, list):
        return []
    calls: list[dict[str, Any]] = []
    entries: list[Any] = items  # pyright: ignore[reportUnknownVariableType]
    for item in entries:
        call = as_object(item)
        if call is not None:
            calls.append(call)
    return calls


def _number(call: dict[str, Any] | None, key: str) -> str:
    value: Any = None if call is None else call.get(key)
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else _NONE


def _tokens(call: dict[str, Any] | None) -> str:
    return "/".join(_number(call, key) for key in ("promptTokens", "completionTokens", "cacheRead"))


def finalization_line(
    record: FinalizationRecord, *, wrap_up: str | None, trace: dict[str, Any] | None
) -> str:
    """The line for a run whose finalization is `record`, its stop reason and call trace."""
    calls = _calls(trace)
    # The call that wrote the review is the last one, or the one before the repair's.
    after = 2 if record.repaired else 1
    final = calls[-after] if len(calls) >= after else None
    repair = calls[-1] if record.repaired and calls else None
    previous = calls[-after - 1] if len(calls) > after else None
    finish: Any = None if final is None else final.get("finishReason")
    return (
        f"finalization first={record.first} repaired={'true' if record.repaired else 'false'} "
        f"second={record.second} wrap_up={wrap_up or 'none'} final_call={record.final_call} "
        f"final_tokens={_tokens(final)} repair_tokens={_tokens(repair)} "
        f"finish={finish if isinstance(finish, str) else _NONE} "
        f"prev_prompt_tokens={_number(previous, 'promptTokens')}"
    )
