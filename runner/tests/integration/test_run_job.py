"""Pins down the runner as a real process: the job goes in on stdin, exactly one line of JSON comes
out on stdout, nothing leaks to either stream, and the environment, argv and working directory stay
free of secrets. PR-Agent's `handle_request` is replaced by a double (pr_agent_double.py), so the
real configuration, patch and recorder run but nothing reaches a network."""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"
DOUBLE = Path(__file__).parent / "pr_agent_double.py"
PR_URL = "https://github.com/octo/repo/pull/7"


def job(**overrides: Any) -> dict[str, Any]:
    value: dict[str, Any] = {
        "prUrl": PR_URL,
        "command": "review",
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": TOKEN,
            "botLogin": "code-reviewer",
        },
        "llm": {"provider": "openrouter", "model": "deepseek/deepseek-chat", "apiKey": API_KEY},
    }
    value.update(overrides)
    return value


def run_double(
    scenario: str,
    tmp_path: Path,
    stdin: str | dict[str, Any] | None = None,
    extra_env: dict[str, str] | None = None,
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    workdir = tmp_path / "work"
    workdir.mkdir()
    report = tmp_path / "report.json"
    text = json.dumps(job() if stdin is None else stdin) if not isinstance(stdin, str) else stdin
    environment = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), **(extra_env or {})}
    process = subprocess.run(
        [sys.executable, str(DOUBLE), scenario, str(report)],
        input=text,
        capture_output=True,
        text=True,
        cwd=workdir,
        env=environment,
        timeout=50,
        check=False,
    )
    seen: dict[str, Any] = json.loads(report.read_text()) if report.exists() else {}
    return process, seen


def result_of(process: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    lines = process.stdout.splitlines()
    assert len(lines) == 1, f"stdout must be exactly one line, got {process.stdout!r}"
    return json.loads(lines[0])


# CR-10-T01
def test_a_valid_review_job_calls_handle_request_once_in_user_mode_and_reports_success(
    tmp_path: Path,
) -> None:
    process, seen = run_double("publish", tmp_path)

    result = result_of(process)
    assert process.returncode == 0
    assert result["ok"] is True
    assert result["errorCode"] is None
    assert result["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"
    assert isinstance(result["durationMs"], int)
    assert seen["calls"] == 1
    assert seen["pr_url"] == PR_URL
    assert seen["request"] == ["review"]
    assert seen["propagate_tool_errors"] is True
    assert seen["deployment_type"] == "user"
    assert seen["git_provider"] == "github"
    assert seen["model"] == "openrouter/deepseek/deepseek-chat"
    assert seen["fallback_models"] == []
    assert seen["token_in_settings"] is True


# CR-10-T02
def test_the_identity_patch_is_active_inside_the_real_process(tmp_path: Path) -> None:
    _, seen = run_double("publish", tmp_path)

    assert seen["login"] == "code-reviewer[bot]"


# CR-10-T04
@pytest.mark.parametrize("stdin", ["", "not json", "{}"])
def test_an_invalid_job_gets_an_invalid_job_result_and_a_non_zero_exit(
    stdin: str, tmp_path: Path
) -> None:
    process, seen = run_double("publish", tmp_path, stdin=stdin)

    result = result_of(process)
    assert process.returncode == 1
    assert result["ok"] is False
    assert result["errorCode"] == "invalid_job"
    assert seen == {}


# CR-10-T06
def test_a_command_outside_the_allowed_set_never_reaches_handle_request(tmp_path: Path) -> None:
    process, seen = run_double("publish", tmp_path, stdin=job(command="review; rm -rf /"))

    assert result_of(process)["errorCode"] == "invalid_command"
    assert process.returncode == 1
    assert seen == {}


# CR-10-T05
def test_an_exception_from_handle_request_gives_one_failed_result_and_no_traceback(
    tmp_path: Path,
) -> None:
    process, _ = run_double("raise", tmp_path)

    result = result_of(process)
    assert process.returncode == 1
    assert result["ok"] is False
    assert result["errorCode"] == "unknown"
    assert "Traceback" not in process.stdout
    assert "Traceback" not in process.stderr


def test_a_failure_comment_from_pr_agent_fails_the_job(tmp_path: Path) -> None:
    process, _ = run_double("failure", tmp_path)

    result = result_of(process)
    assert process.returncode == 1
    assert result["errorCode"] == "command_failed"
    assert result["commentUrl"] is None


def test_output_of_libraries_stays_off_the_result_channel(tmp_path: Path) -> None:
    process, _ = run_double("chatty", tmp_path)

    assert result_of(process)["ok"] is True
    assert "hello from a library" not in process.stdout
    assert "hello from a library" in process.stderr


# CR-10-T07
def test_neither_stdout_nor_stderr_contains_a_secret_that_pr_agent_wrote_everywhere(
    tmp_path: Path,
) -> None:
    process, _ = run_double("leak", tmp_path)

    assert result_of(process)["ok"] is True
    for stream in (process.stdout, process.stderr):
        assert TOKEN not in stream
        assert API_KEY not in stream
    assert "[REDACTED]" in process.stderr
    assert "[REDACTED]" in result_of(process)["logTail"]


# CR-10-T07
def test_secrets_in_an_exception_text_are_redacted_in_every_stream(tmp_path: Path) -> None:
    process, _ = run_double("raise", tmp_path)

    assert TOKEN not in process.stdout + process.stderr
    assert API_KEY not in process.stdout + process.stderr


# CR-10-T08
def test_no_secret_is_in_argv_or_in_a_file_of_the_working_directory(tmp_path: Path) -> None:
    process, seen = run_double("publish", tmp_path)

    assert process.returncode == 0
    assert TOKEN not in json.dumps(seen["argv"])
    assert API_KEY not in json.dumps(seen["argv"])
    assert seen["cwd_files"] == []
    for path in (tmp_path / "work").rglob("*"):
        assert TOKEN not in path.read_text(errors="ignore")
        assert API_KEY not in path.read_text(errors="ignore")


def test_the_environment_of_the_parent_does_not_reach_pr_agent(tmp_path: Path) -> None:
    parent = {
        "GITHUB_APP_PRIVATE_KEY_PATH": "/secret/app.pem",
        "OPENROUTER_API_KEY": "parent-key",
        "AWS_SECRET_ACCESS_KEY": "parent-aws",
        "CONFIG": "stray",
    }

    _, seen = run_double("publish", tmp_path, extra_env=parent)

    names = set(seen["environ_names"])
    assert names.isdisjoint(parent)
    assert {"GITHUB__USER_TOKEN", "OPENROUTER__KEY", "CONFIG__MODEL", "PATH"} <= names


# CR-10-T01
def test_the_console_script_refuses_an_invalid_job_without_loading_pr_agent() -> None:
    script = Path(sys.executable).parent / "code-reviewer-run-job"

    process = subprocess.run(
        [str(script)],
        input="{}",
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    result = json.loads(process.stdout)
    assert process.returncode == 1
    assert result["errorCode"] == "invalid_job"
    assert process.stderr == ""
