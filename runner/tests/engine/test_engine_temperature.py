# SPDX-License-Identifier: Apache-2.0

"""Pins down when a Diff job sends `temperature` (#477): the real PR-Agent and LiteLLM, run through
the real job entry point, against the OpenRouter-shaped fake LLM.

OpenRouter lists no `temperature` for any Claude model from 4.7 on or any GPT-6 model, and with
`provider.require_parameters: true` a request that carries it finds no endpoint (404, shown as
`model_unknown`). PR-Agent 0.47.0 withholds it only for a fixed list of families, so the runner
withholds it for every Claude model from 4.7 on and every GPT-6 model by pattern. A model that
accepts it still gets it.
"""

from typing import Any

import pytest
from fake_github import FakeGithub
from fake_llm import FakeLlm
from harness import Engine

WITHOUT_TEMPERATURE = [
    "anthropic/claude-haiku-5.5",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-opus-5",
    "anthropic/claude-fable-5.1",
    "anthropic/claude-haiku-6",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-haiku-5.5:batch",
    "openai/gpt-6-luna",
    "openai/gpt-6.1-sol",
]
WITH_TEMPERATURE = [
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-4o",
]


def run_with_model(engine: Engine, model: str) -> dict[str, Any]:
    job = engine.job("review")
    job["llm"]["model"] = model
    outcome = engine.run(job=job)
    return outcome.result


# #477-T02
@pytest.mark.parametrize("model", WITHOUT_TEMPERATURE)
def test_a_model_that_takes_no_temperature_gets_none_but_still_requires_parameters(
    engine: Engine, github: FakeGithub, llm: FakeLlm, model: str
) -> None:
    result = run_with_model(engine, model)

    assert result["ok"] is True
    assert llm.requests
    for request in llm.requests:
        assert "temperature" not in request.body
        assert request.body["provider"] == {"require_parameters": True}


# #477-T03
@pytest.mark.parametrize("model", WITH_TEMPERATURE)
def test_a_model_that_takes_temperature_still_gets_it(
    engine: Engine, github: FakeGithub, llm: FakeLlm, model: str
) -> None:
    result = run_with_model(engine, model)

    assert result["ok"] is True
    assert llm.requests
    for request in llm.requests:
        assert request.body["temperature"] == 0.2
        assert request.body["provider"] == {"require_parameters": True}
