# SPDX-License-Identifier: Apache-2.0

"""Pins down the request that leaves the process for a Diff job (#270): the real PR-Agent and
LiteLLM, run through the real job entry point, send `provider.require_parameters: true` to the
OpenRouter-shaped fake LLM, and a "no provider can handle the parameters" answer ends the job with
the existing provider error code, without a retry on another model."""

from fake_github import FakeGithub
from fake_llm import FakeLlm, Reply
from harness import Engine

NO_PROVIDER = (
    "No endpoints found that can handle the requested parameters. "
    "To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing"
)


# #270-T03, #270-T07
def test_every_request_of_a_diff_job_carries_required_parameters_and_the_job_completes(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    outcome = engine.run("review")

    assert outcome.result["ok"] is True
    assert llm.requests
    for request in llm.requests:
        assert request.body["provider"] == {"require_parameters": True}
        # Nothing else about the route: no selector, no order, no fallback switch.
        assert set(request.body["provider"]) == {"require_parameters"}


# #270-T04
def test_a_diff_job_for_a_destination_that_does_not_ask_sends_no_provider_field(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    job = engine.job("review")
    del job["llm"]["requireParameters"]

    outcome = engine.run(job=job)

    assert outcome.result["ok"] is True
    assert llm.requests
    assert all("provider" not in request.body for request in llm.requests)


# #270-T06
def test_no_provider_for_the_parameters_ends_a_diff_job_with_the_provider_error_and_no_fallback(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(status=404, message=NO_PROVIDER)

    outcome = engine.run("review")

    result = outcome.result
    assert outcome.returncode != 0
    assert result["ok"] is False
    assert result["errorCode"] == "model_unknown"
    assert result["commentUrl"] is None
    assert llm.requests
    assert {request.model for request in llm.requests} == {llm.requests[0].model}
