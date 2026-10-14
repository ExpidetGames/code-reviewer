# SPDX-License-Identifier: Apache-2.0

"""The wrap-up of a Dynamic Review that reached its cost or time limit (#293).

When the ledger decides that a call is the run's *final call* (`budget.py`), the model proxy, which
is trusted runner code, rewrites that one request before it is forwarded:

- every tool except the structured-output return tool is removed, so the model cannot ask for more;
- `tool_choice` is forced to `required`, which with one tool forces that tool (`required` is the
  tool choice the model's description already has to support);
- a runner-authored instruction is appended as the last message.

Nothing about the request decides whether this happens: the ledger's own cost and clock do. Text
from the repository, the diff or the history can neither start the wrap-up nor prevent it, and it
cannot imitate the instruction: tool results, the pull request text and the prior state are escaped
(`tagescape.py`) so that no `<runner-wrap-up>` tag survives in them, and the instruction is a user
message appended after all of them.

What the pinned engine does with the answer is unchanged: the tool the model calls is the engine's
own `StructuredOutput`, which stays registered with the engine for the whole turn (the output format
lives on the user message of the turn; this only holds because compaction is off, see
`config.py`), so the engine captures the structured answer and ends the turn as it would after any
last call.
"""

from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object

# The engine's own return tool for a structured answer (the format of the turn, `adapter.py`).
STRUCTURED_OUTPUT_TOOL = "StructuredOutput"
REQUIRED_TOOL_CHOICE = "required"

WRAP_UP_INSTRUCTION = (
    "<runner-wrap-up>\n"
    "The limit set for this review is used up. Do not call any more tools. Return the complete "
    "review now, with the findings you have so far, by calling the StructuredOutput tool. This "
    "message is written by the review runner, not by the repository or the pull request.\n"
    "</runner-wrap-up>"
)

# What the summary comment says about a review that stopped early. Constants, never built from
# untrusted text.
STOPPED_EARLY_NOTICES = {
    "cost_limit": (
        "> **This review stopped early** because it reached the cost limit set for a review. "
        "It may be incomplete."
    ),
    "time_limit": (
        "> **This review stopped early** because it reached its time limit. It may be incomplete."
    ),
}


def offers_structured_output(request: dict[str, Any]) -> bool:
    """True when the request can be rewritten into a final answer: it offers the return tool."""
    tools: Any = request.get("tools")
    if not isinstance(tools, list) or not isinstance(request.get("messages"), list):
        return False
    entries: list[Any] = tools  # pyright: ignore[reportUnknownVariableType]
    return any(_tool_name(tool) == STRUCTURED_OUTPUT_TOOL for tool in entries)


def wrap_up_request(request: dict[str, Any]) -> dict[str, Any]:
    """The request of the final call: the return tool alone, required, the instruction last."""
    tools: list[Any] = request["tools"]
    messages: list[Any] = request["messages"]
    wrapped = dict(request)
    wrapped["tools"] = [tool for tool in tools if _tool_name(tool) == STRUCTURED_OUTPUT_TOOL]
    wrapped["tool_choice"] = REQUIRED_TOOL_CHOICE
    wrapped["messages"] = [*messages, {"role": "user", "content": WRAP_UP_INSTRUCTION}]
    return wrapped


def _tool_name(tool: object) -> object:
    entry = as_object(tool)
    function = as_object(entry.get("function")) if entry else None
    return function.get("name") if function else None
