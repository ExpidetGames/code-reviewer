# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the cost a Diff run reports (#274): the real PR-Agent and LiteLLM, run through the real
job entry point against the OpenRouter-shaped fake LLM. The cost is the sum of the `usage.cost` the
provider states in its answers, all or nothing, and never a figure from a price table."""

import json
from decimal import Decimal
from typing import Any

from fake_github import FakeGithub
from fake_llm import FakeLlm, Reply
from harness import MODEL, Engine, Outcome

FALLBACK = "test/fallback-model"
# A model whose price LiteLLM's table knows: PR-Agent would have worked a cost out for it.
PRICED_IN_THE_TABLE = "deepseek/deepseek-chat"


def exact(charge: float, calls: int) -> float:
    """The charge of `calls` answers added up as decimals."""
    return float(Decimal(repr(charge)) * calls)


def with_fallback(engine: Engine) -> dict[str, Any]:
    job = engine.job("review")
    job["llm"]["fallbackModels"] = [FALLBACK]
    return job


# #274-T05
def test_a_review_reports_the_charge_the_provider_stated_for_each_call(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.cost = 0.00042

    outcome = engine.run("review")

    result = outcome.result
    assert result["ok"] is True
    assert result["errorCode"] is None
    usage = result["usage"]
    assert usage["aiCalls"] == len(llm.requests) >= 1
    assert usage["costUsd"] == exact(0.00042, len(llm.requests))
    assert usage["totalTokens"] == 150 * len(llm.requests)
    assert usage["fallbackUsed"] is False


# #274-T05: the rest of the result is what it was. The optional `findings` of a successful review
# (#405-T31) is the one addition: the active findings, without severities for a Diff Review.
def test_the_result_of_a_review_is_otherwise_unchanged(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    result = engine.run("review").result

    assert set(result) == {
        "ok",
        "durationMs",
        "commentUrl",
        "errorCode",
        "findings",
        "logTail",
        "logTruncated",
        "usage",
    }
    assert result["findings"] == {"open": 1, "bySeverity": None}
    assert set(result["usage"]) == {
        "model",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "aiCalls",
        "fallbackUsed",
        "costUsd",
    }
    assert result["commentUrl"] == github.comment_url(github.comments[0])


# #274-T02
def test_an_answer_without_a_stated_charge_makes_the_cost_null_and_keeps_the_tokens(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.cost = None

    result = engine.run("review").result

    assert result["ok"] is True
    assert result["usage"]["costUsd"] is None
    assert result["usage"]["totalTokens"] == 150 * len(llm.requests)


# #274-T08: PR-Agent would price this model from LiteLLM's table when the answer states nothing.
def test_no_cost_is_worked_out_from_a_price_table_for_a_model_the_table_knows(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.cost = None
    job = engine.job("review")
    job["llm"]["model"] = PRICED_IN_THE_TABLE

    result = engine.run(job=job).result

    assert result["ok"] is True
    assert result["usage"]["aiCalls"] >= 1
    assert result["usage"]["costUsd"] is None


# #274-T08: a stated charge is used as it is, whatever the table says the model costs.
def test_the_stated_charge_is_reported_for_a_model_the_table_knows(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.cost = 0.123
    job = engine.job("review")
    job["llm"]["model"] = PRICED_IN_THE_TABLE

    result = engine.run(job=job).result

    assert result["usage"]["costUsd"] == exact(0.123, len(llm.requests))


# #274-T03: the primary model is refused before any generation (a rate limit), the fallback model
# answers.
def test_a_fallback_after_a_refusal_reports_the_cost_of_the_answer_that_came_back(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.cost = 0.002
    llm.by_model[MODEL] = Reply(status=429, message="rate limited")

    result = engine.run(job=with_fallback(engine)).result

    assert result["ok"] is True
    usage = result["usage"]
    assert usage["fallbackUsed"] is True
    answers = [request for request in llm.requests if request.model == FALLBACK]
    assert len(answers) == usage["aiCalls"] >= 1
    assert usage["costUsd"] == exact(0.002, len(answers))


# #274-T03: an empty answer is billed, PR-Agent throws it away and asks the fallback model: both
# answers are part of the cost, which the sum PR-Agent keeps itself leaves out.
def test_an_answer_pr_agent_throws_away_is_part_of_the_cost(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.cost = 0.002
    llm.by_model[MODEL] = Reply(content="")

    result = engine.run(job=with_fallback(engine)).result

    assert result["ok"] is True
    usage = result["usage"]
    assert usage["fallbackUsed"] is True
    discarded = [request for request in llm.requests if request.model == MODEL]
    answered = [request for request in llm.requests if request.model == FALLBACK]
    assert discarded and answered
    assert usage["aiCalls"] == len(answered)
    assert usage["costUsd"] == exact(0.002, len(discarded) + len(answered))


# #274-T06: the request that leaves the process is the one PR-Agent builds: same destination, same
# credential, nothing added for the measurement.
def test_the_measurement_adds_nothing_to_the_request_and_sends_it_only_to_the_job_destination(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    outcome = engine.run("review")

    assert outcome.result["ok"] is True
    assert llm.requests
    for request in llm.requests:
        assert request.path == "/api/v1/chat/completions"
        assert request.authorization == "Bearer dummy-openrouter-key-0123456789"
        assert request.body["provider"] == {"require_parameters": True}
    assert outcome.connections != []
    assert all(connection["allowed"] for connection in outcome.connections)


# #274-T03: LiteLLM sends a request again inside one call when `num_retries` is set, and the meter
# would see only the last answer. A repository file cannot set it: the failing model is asked as
# often as without the file.
def test_a_repository_file_cannot_make_litellm_retry_inside_one_call(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(status=500, message="upstream failed")

    engine.run("review")
    asked_without_the_file = len(llm.requests)
    github.put_file(".pr_agent.toml", "[config]\nnum_retries = 3\n")
    engine.run("review")
    asked_with_the_file = len(llm.requests) - asked_without_the_file

    assert asked_without_the_file >= 1
    assert asked_with_the_file == asked_without_the_file


# #274-T03: the same run reports no exact cost when the model failed with a server error.
def test_a_run_whose_model_failed_with_a_server_error_reports_no_cost(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.cost = 0.002
    llm.by_model[MODEL] = Reply(status=500, message="upstream failed")

    result = engine.run(job=with_fallback(engine)).result

    assert result["ok"] is True
    assert result["usage"]["fallbackUsed"] is True
    assert result["usage"]["costUsd"] is None


# #363-T01: PR-Agent counts only the calls that came back. The provider accepted the request and
# failed it with a server error: the run has no usage, but the model may have worked on it, so the
# result says so (and the app counts the run with an unknown cost instead of voiding it).
def test_a_run_whose_only_request_failed_with_a_server_error_may_have_used_the_model(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(status=500, message="upstream failed")

    result = engine.run("review").result

    assert result["ok"] is False
    assert len(llm.requests) >= 1
    assert result["usage"] is None
    assert result["errorReason"] == "no_result_from_process"


# #363-T02: the model never answers; the soft timeout ends the run with the request in flight.
def test_a_run_that_times_out_while_its_request_is_in_flight_may_have_used_the_model(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(hold=True)
    # The timeout counts from the start of the process (#387): a start-up that outlasts it ends the
    # job before the model is asked, which is not this case, so the job is run again with more time.
    outcome: Outcome | None = None
    for attempt in range(3):
        process = engine.start(extra_env={"RUNNER_JOB_TIMEOUT_SECONDS": str(3 * 2**attempt)})
        outcome = process.finish(json.dumps(engine.job("review")))
        if llm.requests:
            break
    assert outcome is not None

    result = outcome.result
    assert llm.requests
    assert result["ok"] is False
    assert result["errorCode"] == "timeout"
    assert result["usage"] is None
    assert result["errorReason"] == "no_result_from_process"


# #363-T03: a request the provider refused before it generated anything (a bad key) was not used.
def test_a_run_whose_request_was_refused_before_any_generation_has_no_reason(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(status=401, message="bad key")

    result = engine.run("review").result

    assert result["ok"] is False
    assert len(llm.requests) >= 1
    assert result["usage"] is None
    assert "errorReason" not in result


# #363-T03: no request was sent at all.
def test_a_run_that_fails_before_it_asks_the_model_has_no_usage_and_no_reason(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    github.fail("GET", rf"/repos/octo/widgets/pulls/{github.number}", 404, "Not Found")

    result = engine.run("review").result

    assert result["ok"] is False
    assert llm.requests == []
    assert result["usage"] is None
    assert "errorReason" not in result


# #363-T06: a successful run is as before, with no reason.
def test_a_successful_run_carries_no_reason(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    result = engine.run("review").result

    assert result["ok"] is True
    assert "errorReason" not in result
