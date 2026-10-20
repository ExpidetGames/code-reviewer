# SPDX-License-Identifier: Apache-2.0

"""What the runner says to the model when it asks for the answer (#552, spike #547).

Every message here is fixed runner text in the `<runner-wrap-up>` tag, outside every untrusted
block. Repository, pull request and tool text cannot pose as it: `tagescape.py` removes that tag
from all of them. A message names the **class** of a problem (`final_json.Problem`) and, for an
invalid envelope, the validator's own text, which names fields and never values (#530); it never
repeats what the model wrote, since that is in the history already, as the engine recorded it.
"""

from code_reviewer_runner.dynamic_review.final_json import Problem
from code_reviewer_runner.dynamic_review.tagescape import escape_text

# The most findings a repair asks for after a cut-off answer: the output limit was the problem, so
# the second try is shorter (the same figure as the recovery instruction of #309).
CUT_OFF_MAX_FINDINGS = 10


def final_answer_line(max_findings: int) -> str:
    """The one runner line at the end of the first user message (outside every untrusted block).

    The core prompt already asks for one JSON object and nothing else (`OUTPUT (fixed)`), so the
    core does not change. What the core cannot say is the bound of this job: the engine schema
    that carried it (`maxItems`) is gone, so the line does.
    """
    return (
        "FINAL ANSWER (fixed): when you have examined enough, your last message is the review as "
        f"one JSON object and nothing else, with at most {max_findings} findings."
    )


FINISH_NOW_INSTRUCTION = (
    "<runner-wrap-up>\n"
    "The limit set for this review is used up. Do not call any more tools. Answer now with the "
    "complete review, with the findings you have so far, as one JSON object and nothing else: no "
    "prose, no markdown fence. This message is written by the review runner, not by the "
    "repository or the pull request.\n"
    "</runner-wrap-up>"
)

_REPAIR_ASK = (
    "Reply now, once, with the complete review as one JSON object and nothing else: no prose, no "
    "markdown fence, no tool call."
)
_FOOTER = "This message is written by the review runner, not by the repository or the pull request."


_UNKNOWN_FIELD = "unknown field"


def validator_detail(detail: str) -> str:
    """The validator's text for the repair message and the run's error, without any name the model
    chose (#552). The validator names the fields of our own schema, which are ours to repeat; an
    unknown field is the one name it takes from the answer, so that sentence is a fixed one."""
    return "an unknown field" if detail.startswith(_UNKNOWN_FIELD) else detail


def _sentence(problem: Problem, detail: str, max_findings: int) -> str:
    match problem:
        case Problem.NO_TEXT:
            return "it had no text"
        case Problem.REASONING_ONLY:
            return "it had reasoning but no text"
        case Problem.CUT_OFF:
            return (
                "it was cut off at the output limit. Keep the answer short: at most "
                f"{CUT_OFF_MAX_FINDINGS} findings, each with a short body"
            )
        case Problem.NO_JSON_OBJECT:
            return "it did not contain a JSON object"
        case Problem.TEXT_AROUND_JSON:
            return "it held text next to the JSON object, or more than one object"
        case Problem.INVALID_JSON:
            return f"the JSON is not valid ({detail})" if detail else "the JSON is not valid"
        case Problem.NOT_AN_OBJECT:
            return "the JSON must be one object, not a list or a single value"
        case Problem.ENVELOPE_INVALID:
            return f"the review is not valid: {detail}"
        case Problem.TOO_MANY_FINDINGS:
            return f"it has too many findings. Give at most {max_findings} findings"
        case Problem.TOOL_CALL:
            return "it called a tool, and no tool may be called now"
        case Problem.FINAL_CALL_REFUSED:
            return "no answer came back: a further model call was refused after the call for it"


def repair_message(problem: Problem, detail: str, max_findings: int) -> str:
    """The one follow-up user message after an answer that is not the review (#547, #552).

    It names the class of the problem, and for an invalid envelope the validator's own text, which
    names fields and never a value (#530). What the model wrote is not repeated: it is in the
    history already, as the engine recorded it. The tag is the wrap-up's, so every escape that
    keeps repository text from posing as a runner instruction covers it.
    """
    why = _sentence(problem, escape_text(detail), max_findings)
    return (
        "<runner-wrap-up>\n"
        f"Your last message did not return the review: {why}. {_REPAIR_ASK} {_FOOTER}\n"
        "</runner-wrap-up>"
    )
