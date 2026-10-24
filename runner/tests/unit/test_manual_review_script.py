# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the helper script of the manual real run: the App JWT it creates, the guard that keeps
it on the sandbox repository, and that it never prints the installation token or the LLM key, not
even when the runner's output contains them."""

import importlib.util
import io
import json
import subprocess
import sys
import urllib.error
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

SCRIPT = Path(__file__).parents[2] / "scripts" / "manual_review.py"
TOKEN = "installation-token-for-the-test-0123456789"
API_KEY = "llm-key-for-the-test-0123456789"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("manual_review", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["manual_review"] = module
    spec.loader.exec_module(module)
    return module


def fake_runner(stdout: str) -> Callable[..., subprocess.CompletedProcess[str]]:
    def start(job: dict[str, Any], identity_patch: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess([], 0, stdout=stdout, stderr="")

    return start


def fixed_token(*args: str | Path) -> str:
    return TOKEN


@pytest.fixture(scope="module")
def key_pair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    return private, public


# CR-10-T12 (helper)
def test_the_app_jwt_is_signed_with_rs256_and_valid_for_less_than_ten_minutes(
    key_pair: tuple[str, str],
) -> None:
    private, public = key_pair
    script = load_script()

    encoded = script.create_app_jwt("12345", private, now=1_000_000)
    claims: dict[str, Any] = jwt.decode(
        encoded, public, algorithms=["RS256"], options={"verify_exp": False, "verify_iat": False}
    )

    assert jwt.get_unverified_header(encoded)["alg"] == "RS256"
    assert claims["iss"] == "12345"
    assert claims["exp"] - 1_000_000 <= 10 * 60
    assert claims["iat"] < 1_000_000


def test_only_pull_requests_of_the_sandbox_repository_are_accepted() -> None:
    script = load_script()

    script.check_repository("https://github.com/ExpidetGames/code-reviewer-playground/pull/1")
    for url in (
        "https://github.com/ExpidetGames/code-reviewer/pull/1",
        "https://github.com/other/code-reviewer-playground/pull/1",
        "https://evil.example.com/ExpidetGames/code-reviewer-playground/pull/1",
        "https://github.com/ExpidetGames/code-reviewer-playground/pull/1/files",
    ):
        with pytest.raises(SystemExit):
            script.check_repository(url)


def test_the_script_does_not_print_the_secrets_even_if_the_runner_output_has_them(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")

    def mint(*args: str | Path) -> str:
        return TOKEN

    monkeypatch.setattr(script, "mint_installation_token", mint)
    leaking = subprocess.CompletedProcess(
        args=[], returncode=0, stdout=f'{{"logTail": "{TOKEN}"}}', stderr=f"oops {API_KEY}"
    )

    def start(job: dict[str, Any], identity_patch: bool = True) -> subprocess.CompletedProcess[str]:
        return leaking

    monkeypatch.setattr(script, "start_runner", start)

    code = script.main(["--yes"])

    printed = capsys.readouterr()
    assert code == 2
    assert TOKEN not in printed.out + printed.err
    assert API_KEY not in printed.out + printed.err
    assert "SECRET SCAN FAILED" in printed.out


def test_the_job_it_builds_carries_the_token_only_in_the_git_section() -> None:
    script = load_script()

    job = script.build_job(
        script.DEFAULT_PR_URL, "review", TOKEN, "code-reviewer", API_KEY, "vendor/model", 1000
    )

    assert job["git"]["token"] == TOKEN
    assert job["llm"]["apiKey"] == API_KEY
    assert TOKEN not in str({k: v for k, v in job.items() if k != "git"})


def test_nothing_runs_and_no_token_is_minted_without_the_confirmation_flag(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, "1")

    def must_not_run(*args: Any) -> None:
        raise AssertionError("must not be called without --yes")

    monkeypatch.setattr(script, "mint_installation_token", must_not_run)
    monkeypatch.setattr(script, "start_runner", must_not_run)

    code = script.main([])

    assert code == 2
    assert "--yes" in capsys.readouterr().out


def test_the_installation_token_is_limited_to_the_sandbox_repository_and_review_permissions() -> (
    None
):
    body = load_script().token_request_body()

    assert body["repositories"] == ["code-reviewer-playground"]
    assert body["permissions"] == {"contents": "read", "pull_requests": "write"}


def test_the_context_window_goes_into_the_llm_section_of_the_job() -> None:
    script = load_script()

    job = script.build_job(script.DEFAULT_PR_URL, "review", TOKEN, "x", API_KEY, "v/m", 1000)

    assert job["llm"]["maxTokens"] == 1000
    assert "env" not in job


# CR-44-T02 (helper): the comment id is read from the link the runner reports.
def test_the_comment_id_is_read_from_the_comment_link_of_the_sandbox_repository() -> None:
    script = load_script()
    base = "https://github.com/ExpidetGames/code-reviewer-playground/pull/2"

    assert script.comment_id_from_url(f"{base}#issuecomment-6097473386") == 6097473386
    for url in (
        None,
        base,
        f"{base}#discussion_r12",
        "https://github.com/other/repo/pull/2#issuecomment-1",
        "https://evil.example.com/ExpidetGames/code-reviewer-playground/pull/2#issuecomment-1",
    ):
        assert script.comment_id_from_url(url) is None


# CR-44-T02 (helper): every run leaves a record with the result JSON and the comment text.
def test_a_record_holds_the_run_data_and_the_comment_text(tmp_path: Path) -> None:
    script = load_script()
    result = {
        "ok": True,
        "durationMs": 61000,
        "commentUrl": "https://github.com/ExpidetGames/code-reviewer-playground/pull/1#issuecomment-5",
        "errorCode": None,
        "logTail": "done",
        "usage": {"model": "vendor/model", "promptTokens": 10, "costUsd": 0.002},
    }

    path = script.write_record(
        tmp_path,
        label="m1-pr1-run1",
        pr_url=script.DEFAULT_PR_URL,
        model="vendor/model",
        result=result,
        wall_seconds=63.4,
        comment_body="## Review\n- finding",
    )

    record = json.loads(path.read_text())
    assert record["label"] == "m1-pr1-run1"
    assert record["model"] == "vendor/model"
    assert record["prUrl"] == script.DEFAULT_PR_URL
    assert record["wallSeconds"] == 63.4
    assert record["result"] == result
    assert (tmp_path / "m1-pr1-run1.comment.md").read_text() == "## Review\n- finding"


def test_a_label_that_is_not_a_plain_file_name_is_refused(tmp_path: Path) -> None:
    script = load_script()

    for label in ("../escape", "a/b", "", ".hidden"):
        with pytest.raises(SystemExit):
            script.write_record(
                tmp_path,
                label=label,
                pr_url=script.DEFAULT_PR_URL,
                model="v/m",
                result={},
                wall_seconds=1.0,
                comment_body=None,
            )


def test_the_script_records_the_run_and_never_writes_a_secret_to_disk(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")
    monkeypatch.setattr(script, "mint_installation_token", fixed_token)
    url = f"{script.DEFAULT_PR_URL}#issuecomment-7"
    stdout = json.dumps({"ok": True, "durationMs": 5, "commentUrl": url, "errorCode": None})
    monkeypatch.setattr(script, "start_runner", fake_runner(stdout))
    fetched: list[tuple[str, str | None]] = []

    def fetch(token: str, comment_url: str | None) -> str | None:
        fetched.append((token, comment_url))
        return "the review text"

    monkeypatch.setattr(script, "fetch_comment_body", fetch)

    code = script.main(["--yes", "--record-dir", str(tmp_path), "--label", "run-a"])

    assert code == 0
    assert fetched == [(TOKEN, url)]
    written = "".join(p.read_text() for p in tmp_path.iterdir())
    assert "the review text" in written
    assert TOKEN not in written and API_KEY not in written


@pytest.mark.parametrize("secret", [TOKEN, API_KEY], ids=["installation token", "llm key"])
def test_a_comment_that_contains_a_secret_is_not_written_to_disk(
    secret: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")
    monkeypatch.setattr(script, "mint_installation_token", fixed_token)
    stdout = json.dumps({"ok": True, "durationMs": 5, "commentUrl": None, "errorCode": None})
    monkeypatch.setattr(script, "start_runner", fake_runner(stdout))

    def leaking_fetch(token: str, comment_url: str | None) -> str | None:
        return f"leak {secret}"

    monkeypatch.setattr(script, "fetch_comment_body", leaking_fetch)

    code = script.main(["--yes", "--record-dir", str(tmp_path), "--label", "run-b"])

    assert code == 2
    assert list(tmp_path.iterdir()) == []
    assert secret not in capsys.readouterr().out


def test_a_record_dir_needs_a_label() -> None:
    script = load_script()

    with pytest.raises(SystemExit):
        script.main(["--yes", "--record-dir", "somewhere"])


@pytest.mark.parametrize("label", ["../escape", "a/b", ".hidden", "with space"])
def test_a_bad_label_is_refused_before_anything_is_paid_for(
    label: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, "1")

    def must_not_run(*args: Any) -> None:
        raise AssertionError("must not be called with a bad label")

    monkeypatch.setattr(script, "mint_installation_token", must_not_run)
    monkeypatch.setattr(script, "start_runner", must_not_run)

    with pytest.raises(SystemExit):
        script.main(["--yes", "--record-dir", str(tmp_path), "--label", label])


@pytest.mark.parametrize("existing", ["run-c.json", "run-c.comment.md"])
def test_a_label_that_is_already_recorded_is_refused_before_the_run_and_never_overwritten(
    existing: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, "1")
    (tmp_path / existing).write_text("earlier evidence")

    def must_not_run(*args: Any) -> None:
        raise AssertionError("must not be called when the label is taken")

    monkeypatch.setattr(script, "mint_installation_token", must_not_run)
    monkeypatch.setattr(script, "start_runner", must_not_run)

    with pytest.raises(SystemExit):
        script.main(["--yes", "--record-dir", str(tmp_path), "--label", "run-c"])
    with pytest.raises(SystemExit):
        script.write_record(
            tmp_path,
            label="run-c",
            pr_url=script.DEFAULT_PR_URL,
            model="v/m",
            result={},
            wall_seconds=1.0,
            comment_body="new",
        )

    assert (tmp_path / existing).read_text() == "earlier evidence"


def test_the_result_is_printed_and_recorded_even_if_the_comment_cannot_be_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")
    monkeypatch.setattr(script, "mint_installation_token", fixed_token)
    url = f"{script.DEFAULT_PR_URL}#issuecomment-9"
    stdout = json.dumps(
        {
            "ok": True,
            "durationMs": 5,
            "commentUrl": url,
            "errorCode": None,
            "usage": {"costUsd": 0.01},
        }
    )
    monkeypatch.setattr(script, "start_runner", fake_runner(stdout))

    def failing_fetch(token: str, comment_url: str | None) -> str | None:
        raise urllib.error.URLError("github is down")

    monkeypatch.setattr(script, "fetch_comment_body", failing_fetch)

    code = script.main(["--yes", "--record-dir", str(tmp_path), "--label", "run-d"])

    printed = capsys.readouterr().out
    assert code == 0
    assert '"costUsd": 0.01' in printed
    assert "comment text was not saved" in printed
    assert json.loads((tmp_path / "run-d.json").read_text())["result"]["ok"] is True
    assert not (tmp_path / "run-d.comment.md").exists()


# CR-11-T05 (helper): the control run without the identity patch
def test_the_normal_runner_command_is_the_console_script() -> None:
    command = load_script().runner_command(identity_patch=True)

    assert Path(command[0]).name == "code-reviewer-run-job"
    assert len(command) == 1


def test_the_control_command_runs_python_in_isolated_mode() -> None:
    command = load_script().runner_command(identity_patch=False)

    # -I: neither the current directory nor user site packages are put on sys.path
    assert command[:3] == [sys.executable, "-I", "-c"]


# CR-11-T05 (helper): the real job runs, and the identity patch is not applied
def test_the_control_command_runs_the_real_job_without_the_identity_patch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pr_agent.agent.pr_agent import PRAgent
    from pr_agent.git_providers.github_provider import GithubProvider

    from code_reviewer_runner import runner

    script = load_script()
    original = GithubProvider._resolve_user_login  # pyright: ignore[reportPrivateUsage]
    seen: list[bool] = []

    async def handle_request(
        self: Any, pr_url: str, request: Any, notify: Any = None, propagate_tool_errors: Any = None
    ) -> bool:
        seen.append(
            GithubProvider._resolve_user_login is original  # pyright: ignore[reportPrivateUsage]
        )
        return True

    monkeypatch.setattr(PRAgent, "handle_request", handle_request)
    # The snippet assigns the module attribute; let monkeypatch put the original back afterwards.
    monkeypatch.setattr(runner, "apply_identity_patch", runner.apply_identity_patch)
    job = json.dumps(
        script.build_job(script.DEFAULT_PR_URL, "review", TOKEN, "bot", API_KEY, "v/m", 1000)
    )

    def run(code: str | None) -> None:
        monkeypatch.setattr(sys, "stdin", io.StringIO(job))
        monkeypatch.setattr(sys, "stdout", io.StringIO())
        if code is None:
            runner.main([])
            return
        with pytest.raises(SystemExit):
            exec(code, {})  # the snippet is our own constant

    run(None)  # the normal entry point: the patch is in place while the command runs
    run(script.CONTROL_SNIPPET)  # the control: the stock method

    assert seen == [False, True]


def test_the_flag_for_the_control_run_reaches_the_runner_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, "1")
    monkeypatch.setattr(script, "mint_installation_token", fixed_token)
    flags: list[bool] = []

    def start(job: dict[str, Any], identity_patch: bool = True) -> subprocess.CompletedProcess[str]:
        flags.append(identity_patch)
        return subprocess.CompletedProcess(args=[], returncode=0, stdout="{}", stderr="")

    monkeypatch.setattr(script, "start_runner", start)

    script.main(["--yes"])
    script.main(["--yes", "--no-identity-patch"])

    assert flags == [True, False]


# CR-11-T05 together with CR-44: a control run is recorded like any other run
def test_the_control_flag_reaches_the_runner_start_together_with_the_recording(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")
    monkeypatch.setattr(script, "mint_installation_token", fixed_token)
    url = f"{script.DEFAULT_PR_URL}#issuecomment-7"
    stdout = json.dumps({"ok": True, "durationMs": 5, "commentUrl": url, "errorCode": None})
    flags: list[bool] = []

    def start(job: dict[str, Any], identity_patch: bool = True) -> subprocess.CompletedProcess[str]:
        flags.append(identity_patch)
        return subprocess.CompletedProcess([], 0, stdout=stdout, stderr="")

    def fetch(token: str, comment_url: str | None) -> str | None:
        return "the standalone text"

    monkeypatch.setattr(script, "start_runner", start)
    monkeypatch.setattr(script, "fetch_comment_body", fetch)

    code = script.main(
        ["--yes", "--no-identity-patch", "--record-dir", str(tmp_path), "--label", "control-1"]
    )

    assert code == 0
    assert flags == [False]
    assert json.loads((tmp_path / "control-1.json").read_text())["result"]["ok"] is True
    assert (tmp_path / "control-1.comment.md").read_text() == "the standalone text"


# The runner prints the result as the last line; anything else is an unreadable result.
def test_the_last_line_of_the_runner_output_is_the_result() -> None:
    script = load_script()

    assert script.parse_result('noise\n{"ok": true}\n\n') == {"ok": True}


@pytest.mark.parametrize("stdout", ["", "not json", "[1, 2]", '"text"', "42"])
def test_output_without_a_json_object_as_last_line_is_an_unreadable_result(stdout: str) -> None:
    script = load_script()

    assert script.parse_result(stdout) == {"ok": False, "errorCode": "unreadable_result"}
