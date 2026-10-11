# SPDX-License-Identifier: Apache-2.0

"""Pins down what the real PR-Agent posts for each of the four commands, run through the real job
entry point against the fake GitHub and the fake LLM: who posts, where, and what the result JSON
says. The canned model answers are not judged, only the shape and the place of the output."""

import canned
from fake_github import BOT_LOGIN, FakeGithub
from fake_llm import FakeLlm
from harness import Engine


# CR-41-T01
def test_a_review_is_posted_as_the_bot_and_reported_with_its_url(
    engine: Engine, github: FakeGithub
) -> None:
    outcome = engine.run("review")

    assert outcome.returncode == 0
    assert len(github.comments) == 1
    comment = github.comments[0]
    assert comment.login == BOT_LOGIN
    assert "<!-- pr-agent:review:full -->" in comment.body
    assert github.requests_to("GET", "/user") == []
    result = outcome.result
    assert result["ok"] is True
    assert result["errorCode"] is None
    assert result["commentUrl"] == github.comment_url(comment)


# CR-41-T02
def test_code_suggestions_are_posted_as_one_comment_of_the_bot(
    engine: Engine, github: FakeGithub
) -> None:
    outcome = engine.run("improve")

    assert outcome.returncode == 0
    assert len(github.comments) == 1
    comment = github.comments[0]
    assert comment.login == BOT_LOGIN
    assert "<!-- pr-agent:improve:summary -->" in comment.body
    result = outcome.result
    assert result["ok"] is True
    assert result["commentUrl"] == github.comment_url(comment)


# CR-41-T03
def test_a_question_reaches_the_model_and_the_answer_is_posted_as_the_bot(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    question = "Why does the farewell helper not strip the name?"

    outcome = engine.run("ask", args=[question])

    assert outcome.returncode == 0
    assert [question in request.prompt for request in llm.requests] == [True]
    assert len(github.comments) == 1
    comment = github.comments[0]
    assert comment.login == BOT_LOGIN
    assert canned.ask() in comment.body
    assert github.requests_to("GET", "/user") == []
    result = outcome.result
    assert result["ok"] is True
    assert result["commentUrl"] == github.comment_url(comment)


# CR-41-T04
def test_a_description_replaces_the_text_of_the_pull_request_without_a_comment(
    engine: Engine, github: FakeGithub
) -> None:
    outcome = engine.run("describe")

    assert outcome.returncode == 0
    assert len(github.patched_bodies) == 1
    assert "Adds a greeting helper and a farewell helper" in github.patched_bodies[0]
    assert github.comments == []
    result = outcome.result
    assert result["ok"] is True
    assert result["commentUrl"] is None


# CR-41-T04 (the runner pins the status comment off, a repository file cannot bring it back)
def test_no_status_comment_follows_a_description_even_if_the_repository_file_asks_for_one(
    engine: Engine, github: FakeGithub
) -> None:
    github.put_file(".pr_agent.toml", "[pr_description]\nfinal_update_message = true\n")

    outcome = engine.run("describe")

    assert outcome.result["ok"] is True
    assert len(github.patched_bodies) == 1
    assert github.comments == []
