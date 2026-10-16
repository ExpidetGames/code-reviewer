# SPDX-License-Identifier: Apache-2.0

"""Pins down what the job entry point reports when the model or GitHub misbehave: a stable error
code, a non-zero exit code, exactly one line of JSON on stdout, and no review where there is none.

PR-Agent 0.47.0 always posts a one line "Failed to ..." comment when a command fails and it can
still write. That comment is not a review and is never reported as the result, so the checks below
look for review comments (the hidden marker) and for the reported URL, not for an empty PR."""

import json
import re
import time

import pytest
from fake_github import BOT_LOGIN, Comment, FakeGithub
from fake_llm import FakeLlm, Reply
from harness import Engine

REVIEW_MARKER = "<!-- pr-agent:review:full -->"


def review_comments(github: FakeGithub) -> list[Comment]:
    return [comment for comment in github.comments if REVIEW_MARKER in comment.body]


def assert_single_json_line_without_traceback(stdout: str, stderr: str) -> None:
    assert len(stdout.splitlines()) == 1
    assert "Traceback" not in stdout
    assert "Traceback" not in stderr


# CR-41-T07
def test_a_rate_limited_model_ends_the_job_quickly_with_the_rate_limit_code(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(status=429, message="slow down")
    started = time.monotonic()

    outcome = engine.run("review")

    assert time.monotonic() - started < 60
    assert outcome.returncode != 0
    result = outcome.result
    assert result["ok"] is False
    assert result["errorCode"] == "llm_rate_limit"
    assert result["commentUrl"] is None
    assert review_comments(github) == []
    assert len(llm.requests) == 1


# CR-41-T08
@pytest.mark.parametrize(
    "answer",
    [
        pytest.param("this is not yaml: [unclosed", id="not yaml"),
        pytest.param("```yaml\nsomething: else\n```", id="no review field"),
    ],
)
def test_a_model_answer_that_is_no_review_is_reported_as_invalid_output(
    engine: Engine, github: FakeGithub, llm: FakeLlm, answer: str
) -> None:
    llm.replies["review"] = answer

    outcome = engine.run("review")

    assert outcome.returncode != 0
    assert_single_json_line_without_traceback(outcome.stdout, outcome.stderr)
    result = outcome.result
    assert result["ok"] is False
    assert result["errorCode"] == "llm_output_invalid"
    assert result["commentUrl"] is None
    assert review_comments(github) == []


# CR-41-T09
def test_a_model_that_never_answers_ends_with_the_timeout_code_and_no_process_is_left(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(hold=True)
    # The timeout counts from the start of the process (#387), and the real PR-Agent takes seconds
    # to start on a slow machine: it must be long enough for the model request to be sent first.
    job = engine.start(extra_env={"RUNNER_JOB_TIMEOUT_SECONDS": "20"})

    outcome = job.finish(_stdin(engine))

    assert outcome.returncode != 0
    result = outcome.result
    assert result["ok"] is False
    assert result["errorCode"] == "timeout"
    assert result["commentUrl"] is None
    assert llm.wait_for_disconnect() is True
    assert job.is_gone()
    assert review_comments(github) == []


def _stdin(engine: Engine) -> str:
    return json.dumps(engine.job("review"))


# CR-41-T10
def test_a_pull_request_that_does_not_exist_is_reported_without_asking_the_model(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    github.fail("GET", rf"/repos/octo/widgets/pulls/{github.number}", 404, "Not Found")

    outcome = engine.run("review")

    assert outcome.returncode != 0
    result = outcome.result
    assert result["ok"] is False
    assert result["errorCode"] == "pr_not_found"
    assert result["commentUrl"] is None
    assert llm.requests == []
    assert github.comments == []


# CR-41-T11
def test_a_comment_that_cannot_be_written_is_reported_with_a_git_code(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    github.fail("POST", r"/repos/octo/widgets/issues/7/comments", 500)

    outcome = engine.run("review")

    assert outcome.returncode != 0
    assert_single_json_line_without_traceback(outcome.stdout, outcome.stderr)
    result = outcome.result
    assert result["ok"] is False
    assert re.fullmatch(r"git_[a-z_]+", result["errorCode"])
    assert result["errorCode"] == "git_unavailable"
    assert result["commentUrl"] is None
    assert len(llm.requests) == 1
    assert github.comments == []


# CR-41-T11
def test_an_edit_that_cannot_be_written_is_reported_and_the_old_review_stays(
    engine: Engine, github: FakeGithub
) -> None:
    engine.run("review")
    existing = github.comments[0]
    body_before = existing.body
    github.fail("PATCH", r"/repos/octo/widgets/issues/comments/[0-9]+", 500)

    outcome = engine.run("review")

    assert outcome.returncode != 0
    assert_single_json_line_without_traceback(outcome.stdout, outcome.stderr)
    result = outcome.result
    assert result["ok"] is False
    assert result["errorCode"] == "git_unavailable"
    assert result["commentUrl"] is None
    assert github.comments[0].body == body_before
    assert all(comment.login == BOT_LOGIN for comment in github.comments)
