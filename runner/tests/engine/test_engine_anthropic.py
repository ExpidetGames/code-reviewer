# SPDX-License-Identifier: Apache-2.0

"""A Diff job on the Anthropic provider (#511): the real PR-Agent and LiteLLM, run through the real
job entry point, against the fake LLM speaking the Claude Messages API.

What the Claude API refuses is never sent (`temperature` and `top_p` from Opus 4.7 on, decided by
the flag of the model in the runner's list, not by its name), what it asks for is sent (the key in
`x-api-key`, the version header, a `max_tokens` the model can use), and the cost of the run is
worked out from the usage of the answers with the price list, in exact decimals, or unknown."""

from decimal import Decimal
from typing import Any

import pytest
from fake_github import FakeGithub
from fake_llm import FakeLlm, Reply
from harness import Engine

from code_reviewer_runner.anthropic_models import MODELS

KEY = "dummy-anthropic-api03-dummy-engine-key-0123456789"


def anthropic_job(engine: Engine, model: str) -> dict[str, Any]:
    job = engine.job("review")
    job["llm"]["provider"] = "anthropic"
    job["llm"]["model"] = model
    job["llm"]["apiKey"] = KEY
    return job


# #511-T19
@pytest.mark.parametrize("model", list(MODELS.values()), ids=list(MODELS))
def test_temperature_is_sent_exactly_when_the_flag_of_the_model_says_so_and_never_top_p(
    engine: Engine, github: FakeGithub, llm: FakeLlm, model: Any
) -> None:
    result = engine.run(job=anthropic_job(engine, model.id)).result

    assert result["ok"] is True
    assert llm.requests
    for request in llm.requests:
        assert request.is_messages
        assert ("temperature" in request.body) is model.temperature
        assert "top_p" not in request.body
        assert request.body["model"] == model.id


# #511-T19
def test_a_request_carries_the_key_the_version_and_an_output_the_model_can_use(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    result = engine.run(job=anthropic_job(engine, "claude-opus-5-5")).result

    assert result["ok"] is True
    for request in llm.requests:
        assert request.path.endswith("/api/v1/messages")
        assert request.api_key == KEY
        assert request.anthropic_version == "2023-06-01"
        assert request.authorization == ""
        assert request.body["max_tokens"] == 16_000
        assert "provider" not in request.body
    assert KEY not in result["logTail"]


# #511-T19
def test_a_model_the_list_does_not_know_gets_no_temperature_whatever_its_name_suggests(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    result = engine.run(job=anthropic_job(engine, "claude-haiku-4-5")).result

    assert result["ok"] is True
    assert llm.requests
    for request in llm.requests:
        assert "temperature" not in request.body


# #511-T17
def test_the_cost_is_worked_out_from_the_usage_of_every_answer(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.anthropic_usage = {"input_tokens": 12_000, "output_tokens": 3000}

    result = engine.run(job=anthropic_job(engine, "claude-haiku-5-5")).result

    assert result["ok"] is True
    usage = result["usage"]
    assert usage["aiCalls"] == len(llm.requests) >= 1
    # Haiku 5.5: $0.10 in and $0.50 out per million tokens: 0.0012 + 0.0015 = 0.0027 a call.
    assert Decimal(repr(usage["costUsd"])) == Decimal("0.0027") * len(llm.requests)
    assert usage["totalTokens"] == 15_000 * len(llm.requests)


# #511-T17
def test_cache_tokens_of_an_answer_are_priced_at_their_own_prices(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.anthropic_usage = {
        "input_tokens": 10_000,
        "output_tokens": 3000,
        "cache_read_input_tokens": 20_000,
        "cache_creation_input_tokens": 5000,
        "cache_creation": {"ephemeral_5m_input_tokens": 3000, "ephemeral_1h_input_tokens": 2000},
    }

    result = engine.run(job=anthropic_job(engine, "claude-sonnet-4-6")).result

    assert result["ok"] is True
    # Sonnet 4.6: 10000 x 3 + 3000 x 15 + 20000 x 0.30 + 3000 x 3.75 + 2000 x 6, per million tokens.
    assert Decimal(repr(result["usage"]["costUsd"])) == Decimal("0.10425") * len(llm.requests)


# #511-T17
def test_a_model_the_list_does_not_know_has_an_unknown_cost_not_zero(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    result = engine.run(job=anthropic_job(engine, "claude-haiku-5-5-latest")).result

    assert result["ok"] is True
    assert result["usage"]["aiCalls"] >= 1
    assert result["usage"]["costUsd"] is None


# #511-T17
def test_an_answer_without_usage_makes_the_cost_unknown(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.anthropic_usage = {}

    result = engine.run(job=anthropic_job(engine, "claude-haiku-5-5")).result

    assert result["ok"] is True
    assert result["usage"]["costUsd"] is None


# #511-T25
def test_a_rejected_key_fails_the_job_with_the_auth_code_and_never_shows_the_key(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(status=401, message="invalid x-api-key")
    llm.echo_key_in_errors = True

    result = engine.run(job=anthropic_job(engine, "claude-haiku-5-5")).result

    assert result["ok"] is False
    assert result["errorCode"] == "llm_auth"
    assert KEY not in result["logTail"]
