# SPDX-License-Identifier: Apache-2.0

"""The per-call trace of a Dynamic Review (#541): numbers and enums, never content.

Every model call and every tool call of a run is recorded so that a run that stopped early or cost
more than expected can be explained after the fact. The trace holds sizes, counts, times, the cost
and stable names. No path, no argument value, no tool result and no model text is ever stored: what
the model chose to call a tool that is none of the engine's is stored as `other`, and whether a tool
call repeated an earlier one is a flag, computed from the arguments in memory.
"""

import json
from decimal import Decimal
from typing import Any

from code_reviewer_runner.dynamic_review.audit import ToolAudit
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.call_trace import MAX_TRACE_ENTRIES, CallTrace
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.proxy import (
    ModelProxy,
    capabilities_from_config,
)
from code_reviewer_runner.llm_providers import OPENROUTER

EXPORT = "/job/export"
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


def model_call(trace: CallTrace, **overrides: Any) -> None:
    fields: dict[str, Any] = {
        "t_ms": 10,
        "prompt_tokens": 100,
        "cache_read": 40,
        "cache_write": 20,
        "completion_tokens": 7,
        "cost": Decimal("0.0012"),
        "finish_reason": "tool_calls",
        "final": False,
        "tool_names": ["read", "read", "grep"],
    }
    fields.update(overrides)
    trace.model_call(**fields)


def trace_json(trace: CallTrace) -> dict[str, Any]:
    document = trace.to_json()
    assert document is not None
    return document


# #541-T01
def test_every_model_call_is_one_entry_with_all_its_fields_in_order() -> None:
    trace = CallTrace()
    model_call(trace)
    model_call(trace, t_ms=250, prompt_tokens=180, cache_read=100, cache_write=80, final=True)

    document = trace_json(trace)

    assert document["truncated"] is False
    first, second = document["modelCalls"]
    assert first == {
        "index": 0,
        "tMs": 10,
        "promptTokens": 100,
        "cacheRead": 40,
        "cacheWrite": 20,
        "completionTokens": 7,
        "costUsd": 0.0012,
        "finishReason": "tool_calls",
        "final": False,
        "tools": [{"name": "read", "count": 2}, {"name": "grep", "count": 1}],
    }
    assert (second["index"], second["tMs"], second["final"]) == (1, 250, True)


# #541-T01
def test_a_call_without_usage_records_nulls_never_a_guess() -> None:
    trace = CallTrace()
    model_call(
        trace,
        prompt_tokens=None,
        cache_read=None,
        cache_write=None,
        completion_tokens=None,
        cost=None,
        finish_reason=None,
        tool_names=[],
    )

    (entry,) = trace_json(trace)["modelCalls"]

    assert entry["promptTokens"] is None and entry["completionTokens"] is None
    assert entry["cacheRead"] is None and entry["cacheWrite"] is None
    assert entry["costUsd"] is None and entry["finishReason"] is None
    assert entry["tools"] == []


# #541-T01
def test_a_run_without_a_call_has_no_trace() -> None:
    assert CallTrace().to_json() is None


# #541-T01
def test_a_finish_reason_that_is_not_a_known_one_is_other() -> None:
    trace = CallTrace()
    model_call(trace, finish_reason="/etc/passwd leaked into the reason")

    assert trace_json(trace)["modelCalls"][0]["finishReason"] == "other"


# #541-T01
def test_a_cost_that_is_not_finite_is_unknown() -> None:
    trace = CallTrace()
    model_call(trace, cost=Decimal("Infinity"))

    assert trace_json(trace)["modelCalls"][0]["costUsd"] is None


# #541-T01
def test_a_tool_call_records_its_name_its_result_size_and_whether_it_repeated() -> None:
    trace = CallTrace()
    trace.tool_called("c1", "read", {"filePath": "/job/export/a.py"})
    trace.tool_resulted("c1", 1234)
    trace.tool_called("c2", "grep", {"pattern": "needle"})

    document = trace_json(trace)

    assert document["toolCalls"] == [
        {"index": 0, "name": "read", "resultBytes": 1234, "isRepeat": False},
        {"index": 1, "name": "grep", "resultBytes": None, "isRepeat": False},
    ]


# #541-T02
def test_the_same_tool_with_the_same_arguments_is_a_repeat_whatever_the_key_order() -> None:
    trace = CallTrace()
    trace.tool_called("c1", "grep", {"pattern": "needle", "path": "src"})
    trace.tool_called("c2", "grep", {"path": "src", "pattern": "needle"})
    trace.tool_called("c3", "grep", {"pattern": "needle", "path": "src/sub"})
    trace.tool_called("c4", "glob", {"pattern": "needle", "path": "src"})

    flags = [entry["isRepeat"] for entry in trace_json(trace)["toolCalls"]]

    assert flags == [False, True, False, False]


# #541-T02
def test_a_read_of_the_same_file_spelled_two_ways_is_a_repeat() -> None:
    trace = CallTrace(export_root=EXPORT)
    trace.tool_called("c1", "read", {"filePath": "/job/export/src/a.py"})
    trace.tool_called("c2", "read", {"filePath": "src/a.py"})
    trace.tool_called("c3", "read", {"filePath": "/job/export/src/../src/a.py"})
    trace.tool_called("c4", "read", {"filePath": "src/b.py"})

    flags = [entry["isRepeat"] for entry in trace_json(trace)["toolCalls"]]

    assert flags == [False, True, True, False]


# #541-T02
def test_arguments_that_are_not_an_object_still_compare() -> None:
    trace = CallTrace()
    trace.tool_called("c1", "read", {})
    trace.tool_called("c2", "read", {})

    assert [entry["isRepeat"] for entry in trace_json(trace)["toolCalls"]] == [False, True]


# #541-T03
def test_a_tool_the_engine_does_not_have_is_stored_as_other() -> None:
    trace = CallTrace()
    trace.tool_called("c1", "read /secret/path/token.txt", {})
    model_call(trace, tool_names=["bash", "read /secret/path/token.txt", "glob"])

    document = trace_json(trace)

    assert document["toolCalls"][0]["name"] == "other"
    assert document["modelCalls"][0]["tools"] == [
        {"name": "other", "count": 2},
        {"name": "glob", "count": 1},
    ]
    assert "secret" not in json.dumps(document)


# #541-T04
def test_more_than_the_cap_keeps_the_first_entries_and_says_so() -> None:
    trace = CallTrace()
    for index in range(MAX_TRACE_ENTRIES + 25):
        model_call(trace, t_ms=index)
        trace.tool_called(f"c{index}", "read", {"filePath": f"/job/export/f{index}.py"})

    document = trace_json(trace)

    assert len(document["modelCalls"]) == MAX_TRACE_ENTRIES
    assert len(document["toolCalls"]) == MAX_TRACE_ENTRIES
    assert document["modelCalls"][-1]["tMs"] == MAX_TRACE_ENTRIES - 1
    assert document["truncated"] is True
    assert MAX_TRACE_ENTRIES == 100


# #541-T04
def test_a_repeat_after_the_cap_is_still_known_and_a_late_result_is_ignored() -> None:
    trace = CallTrace()
    for index in range(MAX_TRACE_ENTRIES):
        trace.tool_called(f"c{index}", "read", {"filePath": f"f{index}.py"})
    trace.tool_called("late", "read", {"filePath": "f0.py"})
    trace.tool_resulted("late", 99)  # no entry: nothing happens, nothing fails

    document = trace.to_json()

    assert document is not None
    assert len(document["toolCalls"]) == MAX_TRACE_ENTRIES
    assert document["truncated"] is True


# -- through the ledger, the audit and the proxy -------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


SECRET_PATH = "/job/export/SECRETDIR/secretfile.py"
SECRET_CONTENT = "SECRETCONTENT = 'hunter2'"
SECRET_PATTERN = "SECRETNEEDLE"


def tool_call(call_id: str, name: str, **arguments: Any) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def completion(
    *calls: dict[str, Any], finish: str = "tool_calls", cost: float = 0.001
) -> dict[str, Any]:
    return {
        "id": "chatcmpl-1",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "I will read SECRETTEXT now" if not calls else None,
                    "tool_calls": list(calls),
                },
                "finish_reason": finish,
            }
        ],
        "usage": {
            "prompt_tokens": 90,
            "completion_tokens": 7,
            "cost": cost,
            "prompt_tokens_details": {"cached_tokens": 30, "cache_write_tokens": 10},
        },
    }


def test_the_audit_feeds_the_tool_entries_from_the_calls_and_the_results() -> None:
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    audit = ToolAudit(ledger, export_root=EXPORT)
    read = tool_call("c1", "read", filePath=SECRET_PATH)
    again = tool_call("c2", "read", filePath="SECRETDIR/secretfile.py")

    audit.calls_in_answer(completion(read, again))
    audit.results_in_request(
        [
            {"role": "assistant", "content": None, "tool_calls": [read, again]},
            {"role": "tool", "tool_call_id": "c1", "content": SECRET_CONTENT},
            {"role": "tool", "tool_call_id": "c2", "content": SECRET_CONTENT},
        ]
    )
    # The history is sent again with every request: nothing is counted twice.
    audit.results_in_request(
        [
            {"role": "assistant", "content": None, "tool_calls": [read, again]},
            {"role": "tool", "tool_call_id": "c1", "content": SECRET_CONTENT},
        ]
    )

    document = trace_json(ledger.trace)
    assert [entry["resultBytes"] for entry in document["toolCalls"]] == [
        len(SECRET_CONTENT.encode()),
        len(SECRET_CONTENT.encode()),
    ]
    assert [entry["isRepeat"] for entry in document["toolCalls"]] == [False, True]


def run_proxy(clock: Clock) -> BudgetLedger:
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS, clock=clock)
    answers = [
        completion(
            tool_call("c1", "read", filePath=SECRET_PATH),
            tool_call("c2", "grep", pattern=SECRET_PATTERN),
        ),
        completion(
            tool_call("c3", "read", filePath=SECRET_PATH), tool_call("c4", "bash", cmd="rm -rf /")
        ),
        completion(finish="stop"),
    ]

    def upstream(url: str, body: bytes, headers: dict[str, str], limit: int) -> tuple[int, bytes]:
        clock.now += 2.5
        return 200, json.dumps(answers.pop(0)).encode("utf-8")

    capability = new_proxy_capability()
    proxy = ModelProxy(
        ledger=ledger,
        base_path="/v1",
        model="deepseek/deepseek-v4.1-flash",
        upstream_url="https://provider.invalid/v1/chat/completions",
        upstream_api_key="dummy-key-0123456789",
        upstream_model="deepseek/deepseek-v4.1-flash",
        capabilities=capabilities_from_config(
            json.dumps(
                {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
            )
        ),
        capability=capability,
        post=upstream,
        provider=OPENROUTER,
    )
    proxy.audit.set_export_root(EXPORT)
    history: list[dict[str, Any]] = [{"role": "user", "content": "review this " + "x" * 400}]
    for step in range(3):
        request: dict[str, Any] = {
            "model": "deepseek/deepseek-v4.1-flash",
            "messages": history,
            "tools": [
                {"type": "function", "function": {"name": "StructuredOutput", "parameters": {}}}
            ],
            "tool_choice": "auto",
        }
        response = proxy.handle(
            "POST",
            "/v1/chat/completions",
            json.dumps(request).encode("utf-8"),
            {"Authorization": f"Bearer {capability}"},
        )
        assert response.status == 200, response.body
        message = json.loads(response.body)["choices"][0]["message"]
        if step < 2:
            history.append(message)
            for call in message["tool_calls"]:
                history.append(
                    {"role": "tool", "tool_call_id": call["id"], "content": SECRET_CONTENT}
                )
    return ledger


# #541-T05
def test_the_proxy_records_the_calls_with_usage_cache_cost_and_time() -> None:
    clock = Clock()

    ledger = run_proxy(clock)
    document = trace_json(ledger.trace)

    calls = document["modelCalls"]
    assert [call["index"] for call in calls] == [0, 1, 2]
    assert [call["tMs"] for call in calls] == [0, 2500, 5000]
    assert calls[0]["promptTokens"] == 90 and calls[0]["completionTokens"] == 7
    assert (calls[0]["cacheRead"], calls[0]["cacheWrite"]) == (30, 10)
    assert calls[0]["costUsd"] == 0.001
    assert [call["finishReason"] for call in calls] == ["tool_calls", "tool_calls", "stop"]
    assert calls[0]["tools"] == [{"name": "read", "count": 1}, {"name": "grep", "count": 1}]
    assert calls[1]["tools"] == [{"name": "read", "count": 1}, {"name": "other", "count": 1}]
    assert calls[2]["tools"] == []
    assert [call["final"] for call in calls] == [False, False, False]
    tools = document["toolCalls"]
    assert [(tool["name"], tool["isRepeat"]) for tool in tools] == [
        ("read", False),
        ("grep", False),
        ("read", True),
        ("other", False),
    ]
    assert tools[0]["resultBytes"] == len(SECRET_CONTENT.encode())


# #541-T05
def test_the_trace_is_part_of_the_usage_of_the_run() -> None:
    ledger = run_proxy(Clock())

    usage = ledger.usage("vendor/model").to_json()

    assert usage["callTrace"] == ledger.trace.to_json()
    assert usage["aiCalls"] == 3


# #541-T03
def test_no_path_argument_content_or_model_text_is_ever_in_the_trace() -> None:
    ledger = run_proxy(Clock())

    stored = json.dumps(ledger.usage("vendor/model").to_json())

    for marker in (
        "SECRETDIR",
        "secretfile",
        "SECRETCONTENT",
        "hunter2",
        SECRET_PATTERN,
        "SECRETTEXT",
        "rm -rf",
        "/job/export",
        "bash",
    ):
        assert marker not in stored, marker
    # Only these keys ever appear in the trace.
    trace = json.loads(stored)["callTrace"]
    assert set(trace) == {"truncated", "modelCalls", "toolCalls"}
    assert {key for call in trace["modelCalls"] for key in call} == {
        "index",
        "tMs",
        "promptTokens",
        "cacheRead",
        "cacheWrite",
        "completionTokens",
        "costUsd",
        "finishReason",
        "final",
        "tools",
    }
    assert {key for call in trace["toolCalls"] for key in call} == {
        "index",
        "name",
        "resultBytes",
        "isRepeat",
    }


# #541-T05
def test_a_call_the_provider_refused_is_in_the_trace_with_nothing_known_about_it() -> None:
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)

    def refused(url: str, body: bytes, headers: dict[str, str], limit: int) -> tuple[int, bytes]:
        return 500, b'{"error": {"message": "SECRETTEXT"}}'

    capability = new_proxy_capability()
    proxy = ModelProxy(
        ledger=ledger,
        base_path="/v1",
        model="deepseek/deepseek-v4.1-flash",
        upstream_url="https://provider.invalid/v1/chat/completions",
        upstream_api_key="dummy-key-0123456789",
        upstream_model="deepseek/deepseek-v4.1-flash",
        capabilities=capabilities_from_config(
            json.dumps(
                {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
            )
        ),
        capability=capability,
        post=refused,
        provider=OPENROUTER,
    )
    request: dict[str, Any] = {
        "model": "deepseek/deepseek-v4.1-flash",
        "messages": [{"role": "user", "content": "review"}],
        "tools": [{"type": "function", "function": {"name": "StructuredOutput", "parameters": {}}}],
    }

    proxy.handle(
        "POST",
        "/v1/chat/completions",
        json.dumps(request).encode("utf-8"),
        {"Authorization": f"Bearer {capability}"},
    )

    (entry,) = trace_json(ledger.trace)["modelCalls"]
    assert entry["promptTokens"] is None and entry["costUsd"] is None
    assert entry["finishReason"] is None and entry["tools"] == []
    assert "SECRETTEXT" not in json.dumps(ledger.usage(None).to_json())


def upstream_answering(answer: dict[str, Any]) -> Any:
    def upstream(url: str, body: bytes, headers: dict[str, str], limit: int) -> tuple[int, bytes]:
        return 200, json.dumps(answer).encode("utf-8")

    return upstream


def answer_through(ledger: BudgetLedger, upstream: Any) -> None:
    """One model request through a proxy whose provider is `upstream`; the answer is ignored."""
    capability = new_proxy_capability()
    proxy = ModelProxy(
        ledger=ledger,
        base_path="/v1",
        model="deepseek/deepseek-v4.1-flash",
        upstream_url="https://provider.invalid/v1/chat/completions",
        upstream_api_key="dummy-key-0123456789",
        upstream_model="deepseek/deepseek-v4.1-flash",
        capabilities=capabilities_from_config(
            json.dumps(
                {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
            )
        ),
        capability=capability,
        post=upstream,
        provider=OPENROUTER,
    )
    request: dict[str, Any] = {
        "model": "deepseek/deepseek-v4.1-flash",
        "messages": [{"role": "user", "content": "review"}],
        "tools": [{"type": "function", "function": {"name": "StructuredOutput", "parameters": {}}}],
    }
    proxy.handle(
        "POST",
        "/v1/chat/completions",
        json.dumps(request).encode("utf-8"),
        {"Authorization": f"Bearer {capability}"},
    )


# #541-T05: a call that ends the run because the provider reported no usage
# (DYNAMIC_ACCOUNTING_FAILED) was made and may have been billed: it is in the trace, with nulls
# where nothing is known.
def test_a_call_that_ends_the_run_for_a_missing_usage_is_in_the_trace_with_nulls() -> None:
    ledger = BudgetLedger(DynamicLimits(), unit_costs=UNIT_COSTS)
    answer = completion(tool_call("c1", "read", filePath=SECRET_PATH))
    del answer["usage"]

    answer_through(ledger, upstream_answering(answer))

    (entry,) = trace_json(ledger.trace)["modelCalls"]
    assert entry["index"] == 0
    assert entry["promptTokens"] is None and entry["completionTokens"] is None
    assert entry["cacheRead"] is None and entry["cacheWrite"] is None
    assert entry["costUsd"] is None and entry["tools"] == []
    assert entry["finishReason"] == "tool_calls"
    assert SECRET_PATH not in json.dumps(ledger.usage(None).to_json())


# #541-T05: the same for an answer that is larger than the protocol allows.
def test_a_call_whose_answer_is_over_the_byte_bound_is_in_the_trace_with_nulls() -> None:
    ledger = BudgetLedger(DynamicLimits(max_response_bytes=100), unit_costs=UNIT_COSTS)
    answer = completion(tool_call("c1", "read", filePath=SECRET_PATH))

    answer_through(ledger, upstream_answering(answer))

    (entry,) = trace_json(ledger.trace)["modelCalls"]
    assert entry["promptTokens"] is None and entry["costUsd"] is None
    assert entry["finishReason"] is None and entry["tools"] == []
