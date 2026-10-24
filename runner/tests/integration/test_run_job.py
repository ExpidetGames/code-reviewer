# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the runner as a real process: the job goes in on stdin, exactly one line of JSON comes
out on stdout, nothing leaks to either stream, and the environment, argv and working directory stay
free of secrets. PR-Agent's `handle_request` is replaced by a double (pr_agent_double.py), so the
real configuration, patch and recorder run but nothing reaches a network."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

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
    timeout: int = 50,
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
        timeout=timeout,
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
    assert seen["token_sha256"] == hashlib.sha256(TOKEN.encode()).hexdigest()
    assert seen["key_sha256"] == hashlib.sha256(API_KEY.encode()).hexdigest()


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
    assert {"CONFIG__MODEL", "GITHUB__BASE_URL", "PATH"} <= names


# CR-45-T07
def test_neither_the_token_nor_the_llm_key_is_in_the_process_environment_of_the_run(
    tmp_path: Path,
) -> None:
    _, seen = run_double("publish", tmp_path)

    assert seen["secret_in_environ"] is False
    assert {"GITHUB__USER_TOKEN", "OPENROUTER__KEY", "OPENROUTER_API_KEY"}.isdisjoint(
        seen["environ_names"]
    )
    assert seen["token_sha256"] == hashlib.sha256(TOKEN.encode()).hexdigest()


# CR-45-T07
def test_the_process_environment_holds_no_option_of_the_job(tmp_path: Path) -> None:
    env = {"PR_REVIEWER__EXTRA_INSTRUCTIONS": "@format {env[PATH]}"}

    _, seen = run_double("publish", tmp_path, stdin=job(env=env))

    assert not [name for name in seen["environ_names"] if name.startswith("PR_")]


# CR-45-T01
def test_a_project_rule_that_references_the_environment_stays_literal_in_the_real_process(
    tmp_path: Path,
) -> None:
    rule = "@format {env[PATH]} {this.openrouter.key}"
    env = {
        "PR_REVIEWER__EXTRA_INSTRUCTIONS": rule,
        "PR_REVIEWER__NUM_MAX_FINDINGS": "3",
        "PR_REVIEWER__INLINE_KEY_ISSUES": "true",
    }

    process, seen = run_double("publish", tmp_path, stdin=job(env=env))

    assert result_of(process)["ok"] is True
    assert seen["auto_cast"] is False
    assert seen["options"] == {
        "extra_instructions": rule,
        "num_max_findings": 3,
        "inline_key_issues": True,
    }


# CR-45-T04
def test_an_option_value_of_the_wrong_type_is_an_invalid_job_that_names_the_option(
    tmp_path: Path,
) -> None:
    env = {"PR_REVIEWER__NUM_MAX_FINDINGS": f"[1] {API_KEY}"}

    process, seen = run_double("publish", tmp_path, stdin=job(env=env))

    result = result_of(process)
    assert process.returncode == 1
    assert result["errorCode"] == "invalid_job"
    assert "PR_REVIEWER__NUM_MAX_FINDINGS" in result["logTail"]
    assert API_KEY not in process.stdout + process.stderr
    assert seen == {}


# CR-45-T05
def test_the_context_window_of_the_job_lifts_the_clamp_inside_the_real_process(
    tmp_path: Path,
) -> None:
    llm = {**job()["llm"], "maxTokens": 100000}

    process, seen = run_double("publish", tmp_path, stdin=job(llm=llm))

    assert result_of(process)["ok"] is True
    assert seen["max_model_tokens"] == 100000
    assert seen["custom_model_max_tokens"] == 100000


# CR-45-T06
def test_the_fallback_models_of_the_job_reach_pr_agent(tmp_path: Path) -> None:
    llm = {**job()["llm"], "fallbackModels": ["qwen/qwen3-coder"]}

    process, seen = run_double("publish", tmp_path, stdin=job(llm=llm))

    assert result_of(process)["ok"] is True
    assert seen["fallback_models"] == ["openrouter/qwen/qwen3-coder"]


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


# CR-10-T07 (host-only keys stay ours, in the real process with the real environment)
def test_a_malicious_repository_settings_file_cannot_change_model_endpoints_or_credentials(
    tmp_path: Path,
) -> None:
    llm = {**job()["llm"], "maxTokens": 163840}

    process, seen = run_double("repo", tmp_path, stdin=job(llm=llm))

    assert result_of(process)["ok"] is True
    after = seen["after_repo_file"]
    assert after["model"] == "openrouter/deepseek/deepseek-chat"
    assert after["model_weak"] == "openrouter/deepseek/deepseek-chat"
    assert after["model_reasoning"] == "openrouter/deepseek/deepseek-chat"
    assert after["fallback_models"] == []
    assert after["custom_model_max_tokens"] == 163840
    assert after["publish_output"] is True
    assert after["openrouter_base"] == "https://openrouter.ai/api/v1"
    assert after["openrouter_key_is_ours"] is True
    assert after["github_base"] == "https://api.github.com"
    assert after["github_token_is_ours"] is True
    assert after["extra_headers"] is None
    assert not after["callbacks"]
    assert after["repo_option"] == "a legitimate repository option"
    assert after["model_routing_enable"] is False


# CR-45-T03
def test_a_repository_rule_that_references_a_secret_stays_literal_in_the_real_process(
    tmp_path: Path,
) -> None:
    process, seen = run_double("repo_eval", tmp_path)

    assert result_of(process)["ok"] is True
    after = seen["after_repo_file"]
    expected = "@format {this.openrouter.key} {this.github.user_token} {env[PATH]}"
    assert after["reviewer_instructions"] == expected
    assert after["description_instructions"] == "@jinja {{ this.github.user_token }}"
    assert after["prompt_has_text"] is True
    assert after["prompt_has_token"] is False
    assert after["prompt_has_key"] is False


# CR-45 (the options of the job win over the repository file; this is the documented precedence)
def test_the_options_of_the_job_win_over_the_repository_file_in_the_real_process(
    tmp_path: Path,
) -> None:
    _, seen = run_double("repo", tmp_path, stdin=job(env={"PR_REVIEWER__NUM_MAX_FINDINGS": "3"}))

    assert seen["after_repo_file"]["num_max_findings"] == 3


def run_until_the_command_starts(
    scenario: str, tmp_path: Path, timeout_seconds: int
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any], int]:
    """Run the double with a timeout the command starts within; returns the timeout it took.

    The soft timeout counts from the start of the process (#387), so a start-up (the imports) that
    takes longer than the timeout ends the job before the command starts: the clean result the
    product promises, but not what the caller wants to look at. The double reports when the
    command started (`seen`); if it did not, the run is repeated with twice the time (at most
    three runs), so the tests do not bet on how long the imports of this machine take.
    """
    for attempt in range(3):
        timeout = timeout_seconds * 2**attempt
        directory = tmp_path / f"attempt-{attempt}"
        directory.mkdir()
        process, seen = run_double(
            scenario, directory, extra_env={"RUNNER_JOB_TIMEOUT_SECONDS": str(timeout)}, timeout=90
        )
        if seen.get("calls") == 1 or attempt == 2:
            return process, seen, timeout
    raise AssertionError("unreachable")


# The job timeout, soft (an await) and hard (a call that blocks everything).
def test_a_command_that_awaits_too_long_is_stopped_with_the_timeout_code(tmp_path: Path) -> None:
    process, seen, timeout = run_until_the_command_starts("slow", tmp_path, 4)

    result = result_of(process)
    assert seen["calls"] == 1  # the command was running when the timeout cancelled it
    assert process.returncode == 1
    assert result["errorCode"] == "timeout"
    assert result["ok"] is False
    assert result["logTail"].startswith("timeout: the command did not finish in time")
    # CR-12-T05: the measured duration is the time until the stop, not zero and not the 120 s wait
    assert result["durationMs"] >= timeout * 1000


# #387-T06, #363-T03: the command runs and blocks the loop, so only the watchdog can end it, after
# the timeout and the grace, with its own text. It sent no model request: void, so no reason.
def test_a_command_that_blocks_the_whole_process_is_ended_by_the_watchdog(tmp_path: Path) -> None:
    process, seen, timeout = run_until_the_command_starts("hang", tmp_path, 4)

    result = result_of(process)
    assert seen["calls"] == 1  # the command was started and is what blocked
    assert process.returncode == 1
    assert result["errorCode"] == "timeout"
    assert "errorReason" not in result
    assert result["usage"] is None
    assert result["logTail"].startswith("timeout: the command did not stop")
    assert (timeout + 3) * 1000 <= result["durationMs"] < 40_000  # the timeout and the grace


# #363-T01, #363-T02: the command blocked the loop with a model request sent and never answered:
# the watchdog reads the meter from its own thread and says the model may have been used.
def test_the_watchdog_says_the_model_may_have_been_used_when_a_request_is_open(
    tmp_path: Path,
) -> None:
    process, seen, timeout = run_until_the_command_starts("hang_with_request", tmp_path, 4)

    result = result_of(process)
    assert seen["calls"] == 1
    assert process.returncode == 1
    assert result["errorCode"] == "timeout"
    assert result["errorReason"] == "no_result_from_process"
    assert result["usage"] is None
    assert result["logTail"].startswith(
        "timeout [no_result_from_process]: the command did not stop"
    )
    assert (timeout + 3) * 1000 <= result["durationMs"] < 40_000


# #387-T01: the soft timeout counts from the start of the job (the first line of `main()`). The
# start-up (4.5 s) is longer than the 3 s the watchdog allows after the 4 s timeout, but ends before
# the watchdog (7 s): the deadline has passed by then, so the job ends with the clean soft result
# and the command never starts. Counted from the start of the command, the soft timeout would land
# at 8.5 s, after the watchdog. The margin to the watchdog is 2.5 s of import time on top of the
# 4.5 s.
def test_a_slow_start_does_not_let_the_watchdog_overtake_the_soft_timeout(tmp_path: Path) -> None:
    process, seen = run_double(
        "slow_start", tmp_path, extra_env={"RUNNER_JOB_TIMEOUT_SECONDS": "4"}, timeout=40
    )

    result = result_of(process)
    assert process.returncode == 1
    assert result["ok"] is False
    assert result["errorCode"] == "timeout"
    assert result["logTail"].startswith("timeout: the command did not finish in time")
    assert "errorReason" not in result  # the watchdog's result names "no_result_from_process"
    assert seen == {}  # the command never started
    # Ended by the soft timeout (4 s, not the start-up), before the watchdog (7 s).
    assert 4000 <= result["durationMs"] < 7000


# #387-T05
def test_a_job_that_finishes_inside_the_timeout_reports_what_it_reported_without_one(
    tmp_path: Path,
) -> None:
    (tmp_path / "without").mkdir()
    (tmp_path / "within").mkdir()
    without, _ = run_double("publish", tmp_path / "without")
    within, seen = run_double(
        "publish", tmp_path / "within", extra_env={"RUNNER_JOB_TIMEOUT_SECONDS": "60"}
    )

    result = result_of(within)
    assert within.returncode == 0
    assert result["ok"] is True
    assert result["commentUrl"] == "https://github.com/octo/repo/pull/7#c1"
    assert result.get("usage") == result_of(without).get("usage")
    assert seen["calls"] == 1


def test_the_timeout_variable_of_the_parent_is_not_handed_to_pr_agent(tmp_path: Path) -> None:
    _, seen = run_double("publish", tmp_path, extra_env={"RUNNER_JOB_TIMEOUT_SECONDS": "300"})

    assert "RUNNER_JOB_TIMEOUT_SECONDS" not in seen["environ_names"]


# CR-12-T06
def test_ten_megabytes_of_output_give_a_valid_single_line_result_with_a_marked_tail(
    tmp_path: Path,
) -> None:
    process, _ = run_double("flood", tmp_path, timeout=55)

    result = result_of(process)
    assert process.returncode == 0
    assert result["ok"] is True
    assert len(result["logTail"].encode("utf-8")) <= 4096
    assert result["logTruncated"] is True
    assert "flood 49999" in result["logTail"]
    assert len(process.stdout) < 10_000


# CR-12-T08 and CR-12-T09
def test_hostile_log_text_and_secrets_in_urls_leave_a_valid_result_without_secrets(
    tmp_path: Path,
) -> None:
    process, _ = run_double("hostile", tmp_path)

    result = result_of(process)
    assert process.returncode == 1
    assert result["ok"] is False
    assert result["commentUrl"] is None
    assert result["errorCode"] == "unknown"
    assert "\x1b" not in result["logTail"]  # decoded: the raw line escapes it anyway
    assert "red" in result["logTail"]
    assert "evil.example.com" in result["logTail"]  # it is data in the string, not a field
    for stream in (process.stdout, process.stderr):
        for secret in (TOKEN, API_KEY, quote(TOKEN, safe=""), quote(API_KEY, safe="")):
            assert secret not in stream
