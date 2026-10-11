"""Pins down where the two credentials of a job go through the real PR-Agent: the LLM key reaches
the fake LLM in the Authorization header that LiteLLM's OpenRouter handler builds, the GitHub token
reaches only the fake GitHub, and neither is in the body of any request. A change in how PR-Agent
or LiteLLM passes a key then shows up here and not in production."""

import json

from fake_github import FakeGithub
from fake_llm import FakeLlm
from harness import API_KEY, MODEL, Engine


# CR-41-T01 (the key and the token travel in the right header to the right host)
def test_the_llm_key_arrives_as_a_bearer_token_and_only_at_the_llm(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    outcome = engine.run("review")

    assert outcome.result["ok"] is True
    assert llm.requests != []
    assert {request.authorization for request in llm.requests} == {f"Bearer {API_KEY}"}
    assert {request.model for request in llm.requests} == {MODEL}
    assert all(request.path == "/api/v1/chat/completions" for request in llm.requests)
    assert all(github.token not in json.dumps(request.body) for request in llm.requests)
    assert all(github.token not in request.authorization for request in llm.requests)
    assert all(API_KEY not in request.authorization for request in github.requests)
    assert all(API_KEY.encode() not in request.body for request in github.requests)


# CR-41-T01
def test_the_github_token_arrives_in_the_authorization_header_of_every_github_request(
    engine: Engine, github: FakeGithub
) -> None:
    engine.run("review")

    assert github.requests != []
    assert {request.authorization.split(" ")[-1] for request in github.requests} == {github.token}
    assert all(github.token.encode() not in request.body for request in github.requests)
