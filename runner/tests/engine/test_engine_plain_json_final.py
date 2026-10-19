# SPDX-License-Identifier: Apache-2.0

"""A Dynamic Review that ends as plain JSON text, with the real pinned OpenCode (spike #547).

The engine (v1.19.0) is given no `format`: no `StructuredOutput` tool, no forced `tool_choice`. The
review is the text of the message that ends the turn. The adapter prototype (`plain_json_engine.py`)
validates it with the envelope check, sets `schemaVersion` and `reviewedSha` itself and sends
exactly one repair message through the same session. A scripted OpenAI-compatible model stands in
for the provider, behind the real runner proxy and ledger, like every test of this suite.

These tests prove the mechanics: what the engine sends, what stays identical between the calls (the
prefix a provider caches), how a limit is announced without touching a request, and which failures
end the run. How well a real model follows the instruction can only be measured live, with a key:
`docs/spike/547-plain-json-final.md`, "Live test checklist".
"""

import itertools
import json
import threading
from collections.abc import Callable
from decimal import Decimal
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from opencode_support import (
    Run,
    Step,
    asks,
    findings_for,
    opencode_binary,
    run_engine,
    says,
    tool_call,
)
from plain_json_engine import ByRequestModel, PlainJsonEngine
from plain_json_final import FINISH_NOW_INSTRUCTION, final_answer_line
from test_engine_opencode import prepare, reading

from code_reviewer_runner.dynamic_review.budget import (
    WRAP_UP_RESERVE_SECONDS,
    DynamicLimits,
)
from code_reviewer_runner.result import ErrorCode

# What a model wrote first, from the head of the run.
FirstAnswer = Callable[[str], str]
MAX_FINDINGS = 5  # `dynamic_job` in `opencode_support.py`
TOOLS = {"read", "grep", "glob"}


@pytest.fixture(autouse=True)
def pinned_engine_is_installed() -> None:
    assert opencode_binary().is_file()


def review_text(head_sha: str, *, count: int = 1, constants: bool = False) -> str:
    """The review a model writes under the core prompt: no `schemaVersion`, no `reviewedSha`."""
    document = findings_for(head_sha)
    finding = document["findings"][0]
    document["findings"] = [{**finding, "id": f"f-{index}"} for index in range(count)]
    if not constants:
        del document["schemaVersion"], document["reviewedSha"]
        for entry in document["findings"]:
            del entry["reviewedSha"]
    return json.dumps(document)


def tool_names(request: dict[str, Any]) -> set[str]:
    offered: list[dict[str, Any]] = request.get("tools") or []
    return {tool["function"]["name"] for tool in offered}


def history(request: dict[str, Any]) -> list[dict[str, Any]]:
    return request["messages"]


def assert_same_prefix(requests: list[dict[str, Any]]) -> None:
    """Every call is the previous call's whole conversation and something more: the system prompt,
    the tools, the tool choice and every earlier message are identical, so a provider that caches
    the prefix reads everything before the new message."""
    for earlier, later in itertools.pairwise(requests):
        assert later["messages"][: len(earlier["messages"])] == earlier["messages"]
        for key in ("tools", "tool_choice", "model", "max_tokens"):
            assert later.get(key) == earlier.get(key), key


def run_plain(
    model: ByRequestModel,
    content: Any,
    tmp_path: Path,
    *,
    limits: DynamicLimits | None = None,
    **options: Any,
) -> Run:
    return run_engine(
        model,
        content,
        scratch=tmp_path / "scratch",
        limits=limits,
        clock=options.pop("clock", None),
        engine_factory=partial(PlainJsonEngine, **options),
    )


# #547-T01 (mechanics): correct JSON, no format, no forced tool choice.
def test_a_review_that_ends_in_json_text_needs_no_format_and_no_forced_tool_choice(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    steps: list[Step] = [*reading(content.export, 3), says(review_text(content.head_sha))]
    model = ByRequestModel(steps=steps)
    with model:
        run = run_plain(model, content, tmp_path)

    assert run.answer.ok, run.answer.error
    assert run.answer.findings is not None and len(run.answer.findings.findings) == 1
    # The runner stamped the head itself; the model never wrote it.
    assert run.answer.findings.reviewed_sha == content.head_sha
    assert "schemaVersion:missing" in run.answer.findings.envelope_overrides
    assert len(model.requests) == 4
    for request in model.requests:
        assert request["tool_choice"] == "auto"
        assert tool_names(request) == TOOLS
        assert "response_format" not in request
        assert "StructuredOutput" not in json.dumps(request)
    assert_same_prefix(model.requests)
    # The one runner line about the answer is the end of the first user message; the core is not
    # touched.
    first_user = history(model.requests[0])[1]
    assert first_user["role"] == "user"
    assert first_user["content"].rstrip().endswith(final_answer_line(MAX_FINDINGS))
    assert run.ledger.model_calls == 4
    assert run.ledger.recovered is False
    assert run.ledger.stopped_early is None


# #547-T01 (mechanics): the same review in one fence around the whole message.
def test_a_review_in_one_code_fence_is_the_answer(tmp_path: Path) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    fenced = f"```json\n{review_text(content.head_sha)}\n```"
    model = ByRequestModel(steps=[*reading(content.export, 1), says(fenced)])
    with model:
        run = run_plain(model, content, tmp_path)

    assert run.answer.ok, run.answer.error
    assert len(model.requests) == 2


def _fail_cases() -> list[Any]:
    def around(head: str) -> str:
        return f"Here is my review:\n{review_text(head)}"

    def single_quotes(head: str) -> str:
        return review_text(head).replace('"findings"', "'findings'")

    def no_findings(head: str) -> str:
        return json.dumps({"resolvedIds": []})

    def prose(head: str) -> str:
        return "I looked at it and found nothing wrong."

    def array(head: str) -> str:
        return json.dumps([json.loads(review_text(head))])

    def many(head: str) -> str:
        return review_text(head, count=MAX_FINDINGS + 1)

    cases: list[tuple[FirstAnswer, str, str]] = [
        (around, "text next to the JSON object", "prose-around"),
        (single_quotes, "JSON is not valid", "single-quotes"),
        (no_findings, "the review is not valid: findings is missing", "no-findings-key"),
        (prose, "did not contain a JSON object", "prose-only"),
        (array, "not a list or a single value", "array"),
        (many, f"at most {MAX_FINDINGS} findings", "too-many"),
    ]
    return [pytest.param(first, named, id=name) for first, named, name in cases]


# #547-T06 (mechanics): one repair message, in the same session, after every class of failure.
@pytest.mark.parametrize(("first", "named"), _fail_cases())
def test_a_failed_answer_gets_one_repair_message_in_the_same_session_with_a_stable_prefix(
    tmp_path: Path, first: FirstAnswer, named: str
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    steps: list[Step] = [
        *reading(content.export, 2),
        says(first(content.head_sha)),
        says(review_text(content.head_sha)),
    ]
    model = ByRequestModel(steps=steps)
    with model:
        run = run_plain(model, content, tmp_path)

    assert run.answer.ok, run.answer.error
    assert len(model.requests) == 4
    repair = model.requests[3]
    before = model.requests[2]
    # The repair call is the earlier call, then the bad answer as the engine recorded it, then the
    # runner's message: nothing before it moved, and the tools and the tool choice are the same.
    assert_same_prefix(model.requests)
    assert [message["role"] for message in history(repair)[len(history(before)) :]] == [
        "assistant",
        "user",
    ]
    assert history(repair)[-2]["content"] == first(content.head_sha)
    last = history(repair)[-1]["content"]
    assert last.startswith("<runner-wrap-up>\n") and named in last
    assert tool_names(repair) == TOOLS and repair["tool_choice"] == "auto"


# #547-T05 (mechanics): the output limit cut the answer, or the thinking ate all of it.
@pytest.mark.parametrize(
    ("reply", "named"),
    [
        (
            {
                "role": "assistant",
                "content": '{"resolvedIds": [], "findings": [{"id": "f',
                "finish_reason": "length",
            },
            "cut off at the output limit",
        ),
        (
            {
                "role": "assistant",
                "content": None,
                "reasoning_content": "thinking",
                "finish_reason": "length",
            },
            "cut off at the output limit",
        ),
        (
            {"role": "assistant", "content": None, "reasoning_content": "thinking"},
            "reasoning but no text",
        ),
        ({"role": "assistant", "content": ""}, "it had no text"),
    ],
    ids=["cut-off-json", "cut-off-in-thinking", "reasoning-only", "empty"],
)
def test_an_answer_that_is_cut_off_or_missing_is_named_in_the_one_repair_message(
    tmp_path: Path, reply: dict[str, Any], named: str
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    steps: list[Step] = [*reading(content.export, 1), reply, says(review_text(content.head_sha))]
    model = ByRequestModel(steps=steps)
    with model:
        run = run_plain(model, content, tmp_path)

    assert run.answer.ok, run.answer.error
    assert len(model.requests) == 3
    assert named in history(model.requests[2])[-1]["content"]
    assert_same_prefix(model.requests)


# #547-T06 (mechanics): a model that thinks keeps its reasoning in the history of the repair call.
def test_the_reasoning_of_the_failed_answer_stays_in_the_history_of_the_repair(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    first = {"role": "assistant", "content": "Looks fine.", "reasoning_content": "hm, fine"}
    steps: list[Step] = [first, says(review_text(content.head_sha))]
    model = ByRequestModel(steps=steps)
    with model:
        run = run_plain(model, content, tmp_path)

    assert run.answer.ok, run.answer.error
    replayed = history(model.requests[1])[2]
    assert replayed["role"] == "assistant"
    assert replayed["content"] == "Looks fine."
    assert replayed["reasoning_content"] == "hm, fine"


# #547-T06 (mechanics): exactly one repair, whatever the second answer is.
@pytest.mark.parametrize(
    ("second", "code"),
    [
        ("still prose, MODEL_TEXT_MARKER", ErrorCode.LLM_OUTPUT_INVALID),
        ('{"MODEL_TEXT_MARKER": 1', ErrorCode.LLM_OUTPUT_INVALID),
        ({"role": "assistant", "content": ""}, ErrorCode.LLM_OUTPUT_INVALID),
        ('{"resolvedIds": []}', ErrorCode.DYNAMIC_POLICY_VIOLATION),
    ],
    ids=["prose-twice", "invalid-twice", "nothing-twice", "envelope-twice"],
)
def test_an_answer_that_is_still_wrong_after_the_one_repair_fails_the_run(
    tmp_path: Path, second: str | dict[str, Any], code: ErrorCode
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    reply: Step = second if isinstance(second, dict) else says(second)
    steps: list[Step] = [
        *reading(content.export, 1),
        says("prose first"),
        reply,
        says("never asked"),
    ]
    model = ByRequestModel(steps=steps)
    with model:
        run = run_plain(model, content, tmp_path)

    assert run.answer.findings is None
    assert run.answer.error is not None and run.answer.error.code == code
    # One read, the answer, the repair; no third message, no forced call after it.
    assert len(model.requests) == 3
    # The failure names classes and fields, never what the model wrote.
    assert "MODEL_TEXT_MARKER" not in str(run.answer.error)
    assert "prose first" not in str(run.answer.error)


# #547-T04 (mechanics): the engine's own errors are not answers to repair.
def test_an_error_of_the_engine_is_not_repaired(tmp_path: Path) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    blocked: Step = {"role": "assistant", "content": "", "finish_reason": "content_filter"}
    model = ByRequestModel(steps=[*reading(content.export, 1), blocked, says("not asked")])
    with model:
        run = run_plain(model, content, tmp_path)

    assert run.answer.error is not None and run.answer.error.code == ErrorCode.LLM_OUTPUT_INVALID
    assert "ContentFilterError" in run.answer.error.detail
    assert len(model.requests) == 2


def finish_when_asked(export: Path, answer: str, *, ignore: bool = False) -> list[Step]:
    """Twenty reading steps that become the answer the moment the runner's message is in the
    conversation (or never, for a model that ignores it)."""

    def step(request: dict[str, Any]) -> dict[str, Any]:
        asked = any(m.get("content") == FINISH_NOW_INSTRUCTION for m in request["messages"])
        if asked and not ignore:
            return says(answer)
        return asks(tool_call("again", "read", {"filePath": str(export / "src/app.py")}))

    return [step] * 20


def hold_until_announced(
    count: int, announced: threading.Event, move: list[float] | None = None
) -> Callable[[int], None]:
    """Hold the provider's answer to request `count` until the adapter has announced the limit (or
    ten seconds have passed), so the message reaches the engine while that call is in flight."""

    def on_request(number: int) -> None:
        if number != count:
            return
        if move is not None:
            move[0] += 460.0
        announced.wait(10.0)

    return on_request


# #547-T04 (mechanics): the cost limit is announced to the model as one more user message; the
# request is not rewritten, the tools do not change, the prefix stays.
def test_a_run_near_its_cost_limit_is_asked_to_answer_by_a_message_not_by_a_tool_change(
    tmp_path: Path,
) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    announced = threading.Event()
    answer = review_text(content.head_sha)
    model = ByRequestModel(
        steps=finish_when_asked(content.export, answer),
        cost=0.01,
        on_request=hold_until_announced(4, announced),
    )
    with model:
        run = run_plain(
            model,
            content,
            tmp_path,
            limits=DynamicLimits(max_cost_usd=Decimal("0.1")),
            soft_cost_usd=Decimal("0.03"),
            announced=announced,
        )

    assert run.answer.ok, run.answer.error
    assert run.answer.findings is not None and len(run.answer.findings.findings) == 1
    engine = run.engine
    assert isinstance(engine, PlainJsonEngine)
    assert engine.wrap_up_reason == "cost_limit" and engine.wrap_up_stored is True
    final = model.requests[-1]
    asked = [m for m in history(final) if m.get("content") == FINISH_NOW_INSTRUCTION]
    assert len(asked) == 1 and asked[0]["role"] == "user"
    # Appended at the end of what the engine had so far, before the answer was asked for.
    assert history(final)[-1] == asked[0]
    assert all(
        m.get("content") != FINISH_NOW_INSTRUCTION for r in model.requests[:-1] for m in history(r)
    )
    assert_same_prefix(model.requests)
    assert all(tool_names(r) == TOOLS and r["tool_choice"] == "auto" for r in model.requests)
    usage = run.ledger.usage(None)
    assert usage.cost_usd is not None and usage.cost_usd <= 0.1


# #547-T04 (mechanics): the same for the clock of the whole job.
def test_a_run_near_its_deadline_is_asked_to_answer_by_a_message_too(tmp_path: Path) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    announced = threading.Event()
    seconds = [0.0]
    model = ByRequestModel(
        steps=finish_when_asked(content.export, review_text(content.head_sha)),
        on_request=hold_until_announced(2, announced, seconds),
    )
    with model:
        run = run_plain(
            model,
            content,
            tmp_path,
            clock=lambda: seconds[0],
            soft_seconds=WRAP_UP_RESERVE_SECONDS,
            announced=announced,
        )

    assert run.answer.ok, run.answer.error
    engine = run.engine
    assert isinstance(engine, PlainJsonEngine)
    assert engine.wrap_up_reason == "time_limit"
    assert history(model.requests[-1])[-1]["content"] == FINISH_NOW_INSTRUCTION
    assert_same_prefix(model.requests)


# #547-T04 (mechanics): the ledger stays the hard limit; a model that ignores the message ends the
# run at the limit, with no partial result.
def test_a_model_that_ignores_the_message_is_stopped_by_the_hard_cost_limit(tmp_path: Path) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    announced = threading.Event()
    model = ByRequestModel(
        steps=finish_when_asked(content.export, "unused", ignore=True),
        cost=0.01,
        on_request=hold_until_announced(4, announced),
    )
    with model:
        run = run_plain(
            model,
            content,
            tmp_path,
            limits=DynamicLimits(max_cost_usd=Decimal("0.1")),
            soft_cost_usd=Decimal("0.03"),
            announced=announced,
        )

    assert run.answer.findings is None
    assert run.answer.error is not None
    assert run.answer.error.code == ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    usage = run.ledger.usage(None)
    assert usage.cost_usd is not None and usage.cost_usd <= 0.1


# #547-T04 (mechanics): the `tools` map of a message can forbid every tool for that message. It is
# a tool change: the request leaves them out, so the cached prefix and the thinking blocks that
# were bound to the tool set do not carry over. Not needed for the repair; kept for the live test.
def test_the_tools_map_of_a_message_removes_the_tools_from_that_call_only(tmp_path: Path) -> None:
    content = prepare(tmp_path, {"src/app.py": b"x = 1\n"})
    stubborn = asks(tool_call("stubborn", "read", {"filePath": str(content.export / "src/app.py")}))
    steps: list[Step] = [
        *reading(content.export, 1),
        says("prose first"),
        stubborn,
        says(review_text(content.head_sha)),
    ]
    model = ByRequestModel(steps=steps)
    with model:
        run = run_plain(model, content, tmp_path, forbid_tools_on_repair=True)

    assert run.answer.ok, run.answer.error
    kept, repaired = model.requests[1], model.requests[2]
    assert tool_names(kept) == TOOLS
    # The repair call has no tools and no tool choice at all.
    assert "tools" not in repaired and "tool_choice" not in repaired
    # A model that calls a tool anyway gets the engine's refusal as the result; the turn goes on.
    refused = history(model.requests[3])[-1]
    assert refused["role"] == "tool"
    assert "unavailable tool" in refused["content"]
