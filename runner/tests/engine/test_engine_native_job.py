# SPDX-License-Identifier: Apache-2.0

"""A whole native Dynamic job through `run_dynamic_job` with the real pinned OpenCode (#578).

The claim carries the model entry and the cost policy; the runner starts the passthrough proxy with
that entry, writes only that model into the engine's configuration, runs the plain-final engine
path, books the usage by the parsers of the family, enforces the policy and logs one finalization
line. The provider is the strict generic fake of `fakes/wire`, which accepts only the real key under
the real header, so a run that gets a review proves the engine never needed the key. An engine start
costs about five seconds, so the cases are few and each is a whole job.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from fakes.wire.formats import Family, Turn
from native_full_job import MANAGED, OWN, FullJob, full_job
from opencode_native import REAL_KEY
from opencode_support import opencode_binary
from plain_final_support import reads, review, user_texts

from code_reviewer_runner.dynamic_review.final_messages import FINISH_NOW_INSTRUCTION

pytestmark = pytest.mark.engine

TOOLS = {"read", "grep", "glob"}


@pytest.fixture(autouse=True)
def pinned_engine_is_installed() -> None:
    assert opencode_binary().is_file()


def tool_names(request: dict[str, Any]) -> set[str]:
    """The tools of a request of either family (Chat nests the name in `function`)."""
    names: set[str] = set()
    for tool in request.get("tools", []):
        names.add(tool["function"]["name"] if "function" in tool else tool["name"])
    return names


def three_reads_then_the_review(export: Path) -> list[Turn]:
    return [*reads(export, 3), Turn(text=review())]


def assert_a_native_review(job: FullJob) -> None:
    result = job.result
    assert result.ok, result.log_tail
    assert result.comment_url == job.publisher.URL
    assert len(job.publisher.calls) == 1
    assert len(job.publisher.calls[0].findings) == 1
    # No request carries what the legacy path needs to finish a review.
    assert job.requests
    for request in job.requests:
        assert tool_names(request) == TOOLS
        assert request.get("tool_choice") in (None, "auto", {"type": "auto"})
        assert "StructuredOutput" not in str(request)
        assert not {"response_format", "output_config", "output_format"} & request.keys()
    # Prompt caching stays on: the engine itself marks the prefix, we set nothing (the claim's
    # provider is a real one, so the engine's own rule for it applies).
    if job.family == "messages":
        assert all("cache_control" in json.dumps(request) for request in job.requests)
    # The engine's configuration holds one provider with one model, the capability and no key.
    ((config,),) = [job.configs]
    assert len(config["provider"]) == 1
    ((block,),) = [config["provider"].values()]
    assert len(block["models"]) == 1
    assert block["options"]["apiKey"] != REAL_KEY
    assert REAL_KEY not in json.dumps(config)
    assert REAL_KEY not in job.result.to_line()


# #578-T15, #578-T17: a whole job on the managed key
def test_a_whole_native_job_on_the_managed_key_publishes_a_review(tmp_path: Path) -> None:
    with full_job(tmp_path, three_reads_then_the_review, cost=MANAGED) as job:
        assert_a_native_review(job)
        usage = job.result.usage
        assert usage is not None
        # Every call the provider answered is booked, priced by the book of the claim.
        assert usage.ai_calls == len(job.records)
        assert usage.cost_usd is not None and usage.cost_usd > 0
        assert usage.stopped_early is None
        assert (
            "finalization first=ok repaired=false second=none wrap_up=none final_call=normal"
            in job.result.log_tail
        )


# #578-T15: the same on an own key without a price: no cost is reported, and the run is bound by
# the token cap and still publishes
def test_a_whole_native_job_on_an_own_key_without_a_price_reports_no_cost(
    tmp_path: Path,
) -> None:
    with full_job(tmp_path, three_reads_then_the_review, cost=OWN) as job:
        assert_a_native_review(job)
        usage = job.result.usage
        assert usage is not None
        assert usage.cost_usd is None
        assert usage.ai_calls == len(job.records)


# #578-T15: the passthrough does not care for the family; Chat is the other one the fake speaks
@pytest.mark.parametrize("family", ["chat"])
def test_a_whole_native_job_runs_on_another_family(tmp_path: Path, family: Family) -> None:
    with full_job(tmp_path, three_reads_then_the_review, family=family, cost=MANAGED) as job:
        assert_a_native_review(job)


def many_reads(export: Path) -> list[Turn]:
    return [*reads(export, 6) * 6, Turn(text=review())]


def answer_when_asked_twice(scene: Any, request: dict[str, Any]) -> None:
    asked = [
        text
        for text in user_texts(request)
        if text == FINISH_NOW_INSTRUCTION
        or (text.startswith('<runner-wrap-up id="') and "Do not call any more tools" in text)
    ]
    if len(asked) >= 2:
        scene.answer_next_with(Turn(text=review()))


# #578-T16: a model that ignores the finish-now message meets the cost guard, and the job still
# ends with a published review: the final call is the exemption, never an error of the guard
def test_a_job_at_its_cost_limit_ends_with_a_review_and_not_with_the_cost_guard(
    tmp_path: Path,
) -> None:
    with full_job(
        tmp_path, many_reads, cost=MANAGED, limit="0.10", react=answer_when_asked_twice
    ) as job:
        assert_a_native_review(job)
        usage = job.result.usage
        assert usage is not None
        assert usage.stopped_early == "cost_limit"
        assert job.publisher.calls[0].stopped_early == "cost_limit"
        assert "final_call=exempt" in job.result.log_tail
