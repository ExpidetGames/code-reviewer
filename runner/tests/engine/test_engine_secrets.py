"""Pins down that no credential of a job is found anywhere after a run: not on stdout or stderr, not
in the log tail, not in a posted comment or the new text of the pull request, not in a file the job
left behind, not in the command line or the environment of the process. The fakes make this a hard
test: their error answers quote the key or token they received, like "Incorrect API key provided",
so the secret really is in PR-Agent's memory and in its exception texts when it is logged."""

import json
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import pytest
from fake_github import FakeGithub
from fake_llm import FakeLlm, Reply
from harness import API_KEY, Engine, Outcome

SECRET_FREE = "[REDACTED]"


def llm_rate_limit(github: FakeGithub, llm: FakeLlm) -> None:
    llm.override = Reply(status=429, message="slow down")
    llm.echo_key_in_errors = True


def llm_invalid_output(github: FakeGithub, llm: FakeLlm) -> None:
    llm.replies = {kind: "this is not yaml: [unclosed" for kind in llm.replies}
    llm.echo_key_in_errors = True


def pull_request_missing(github: FakeGithub, llm: FakeLlm) -> None:
    github.echo_token_in_errors = True
    github.fail("GET", rf"/repos/octo/widgets/pulls/{github.number}", 404, "Not Found")


def comment_write_fails(github: FakeGithub, llm: FakeLlm) -> None:
    github.echo_token_in_errors = True
    github.fail("POST", r"/repos/octo/widgets/issues/7/comments", 500)
    github.fail("PATCH", r"/repos/octo/widgets/pulls/7", 500)


SCENARIOS: dict[str, Callable[[FakeGithub, FakeLlm], None]] = {
    "success": lambda github, llm: None,
    "llm rate limit": llm_rate_limit,
    "invalid model output": llm_invalid_output,
    "pull request missing": pull_request_missing,
    "comment write fails": comment_write_fails,
}


def assert_no_secret(engine: Engine, outcome: Outcome, secrets: list[str]) -> None:
    github = engine.github
    texts: dict[str, str] = {
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "argv": " ".join(outcome.argv),
        "comments": "\n".join(comment.body for comment in github.comments),
        "pull request text": "\n".join([*github.patched_bodies, *github.patched_titles]),
    }
    for path in outcome.files():
        texts[f"file {path.name}"] = path.read_bytes().decode("utf-8", errors="replace")
    for name, text in texts.items():
        for secret in secrets:
            assert secret not in text, f"a secret is in the {name}"


# CR-41-T12
@pytest.mark.parametrize("scenario", list(SCENARIOS))
@pytest.mark.parametrize("command", ["review", "improve", "ask", "describe"])
def test_no_credential_of_the_job_is_in_any_output_of_a_run(
    engine: Engine, github: FakeGithub, llm: FakeLlm, command: str, scenario: str
) -> None:
    SCENARIOS[scenario](github, llm)

    outcome = engine.run(command)

    assert_no_secret(engine, outcome, [github.token, API_KEY])
    assert outcome.result["logTail"].count(github.token) == 0
    assert outcome.result["logTail"].count(API_KEY) == 0


# CR-41-T12
@pytest.mark.parametrize("command", ["review", "ask"])
def test_a_quoted_llm_key_is_replaced_in_the_log_tail(
    engine: Engine, github: FakeGithub, llm: FakeLlm, command: str
) -> None:
    llm_rate_limit(github, llm)

    outcome = engine.run(command)

    assert SECRET_FREE in outcome.result["logTail"]
    assert API_KEY not in outcome.stdout


# CR-41-T12
def test_a_quoted_github_token_is_replaced_in_the_log_tail(
    engine: Engine, github: FakeGithub
) -> None:
    comment_write_fails(github, engine.llm)

    outcome = engine.run("review")

    assert SECRET_FREE in outcome.result["logTail"]
    assert github.token not in outcome.stdout


# CR-41-T12
def test_a_running_job_shows_no_credential_in_its_command_line_or_environment(
    engine: Engine, github: FakeGithub, llm: FakeLlm
) -> None:
    llm.override = Reply(hold=True)
    job = engine.start()

    with ThreadPoolExecutor(max_workers=1) as pool:
        finished = pool.submit(job.finish, json.dumps(engine.job("review")))
        # The model has the request and does not answer: the process is alive and in the middle of
        # the command, which is when somebody could look at it.
        llm.wait_for_request()
        command_line = job.command_line()
        environment = job.environment_text()
        llm.release.set()
        finished.result(timeout=150)

    assert "code-reviewer-run-job" in command_line
    assert "HOME=" in environment
    for text in (command_line, environment):
        assert github.token not in text
        assert API_KEY not in text
