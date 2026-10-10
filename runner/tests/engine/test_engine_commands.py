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
    outcome = engine.run("describe", env={"PR_DESCRIPTION__FINAL_UPDATE_MESSAGE": "false"})

    assert outcome.returncode == 0
    assert len(github.patched_bodies) == 1
    assert "Adds a greeting helper and a farewell helper" in github.patched_bodies[0]
    assert github.comments == []
    result = outcome.result
    assert result["ok"] is True
    assert result["commentUrl"] is None


# CR-41-T04 (the default settings of a job)
def test_a_description_also_posts_the_status_line_unless_the_job_switches_it_off(
    engine: Engine, github: FakeGithub
) -> None:
    # Documents what the runner does today: PR-Agent's `pr_description.final_update_message` is on
    # and the runner does not pin it (it pins the reviewer's), so a description is followed by a
    # one line comment that links the pull request. It is not the description, and it is not the
    # result: the commentUrl stays null.
    outcome = engine.run("describe")

    assert len(github.patched_bodies) == 1
    assert [comment.body.startswith("**[PR Description]") for comment in github.comments] == [True]
    assert outcome.result["ok"] is True
    assert outcome.result["commentUrl"] is None
