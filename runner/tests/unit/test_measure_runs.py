"""Pins down the driver of the CR-13 measurements: it only talks to the sandbox repository, never
runs without confirmation, keeps the secrets out of every command line, builds the right commands
for a host run and a container run, and summarizes repeated runs."""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SCRIPTS = Path(__file__).parents[2] / "scripts"
TOKEN = "installation-token-for-the-test-0123456789"
API_KEY = "llm-key-for-the-test-0123456789"


def load_script() -> ModuleType:
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location("measure_runs", SCRIPTS / "measure_runs.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules["measure_runs"] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPTS))


def test_the_three_sizes_map_to_the_three_playground_pull_requests() -> None:
    script = load_script()

    assert script.pr_url_for("small").endswith("code-reviewer-playground/pull/1")
    assert script.pr_url_for("medium").endswith("code-reviewer-playground/pull/2")
    assert script.pr_url_for("large").endswith("code-reviewer-playground/pull/3")


def test_nothing_runs_without_the_confirmation_flag(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, "1")

    def must_not_run(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("must not be called without --yes")

    monkeypatch.setattr(script, "mint_installation_token", must_not_run)
    monkeypatch.setattr(script, "run_wrapper", must_not_run)

    assert script.main(["--size", "small"]) == 2
    assert "--yes" in capsys.readouterr().out


def test_the_host_command_runs_the_wrapper_with_the_console_script_of_this_environment() -> None:
    script = load_script()

    command = script.wrapper_command(count=2, concurrency=None, fake_llm=True, docker=None)

    assert command[0] == sys.executable
    assert Path(command[1]).name == "measure_child.py"
    assert command[command.index("--count") + 1] == "2"
    assert "--fake-llm" in command
    assert Path(command[-1]).name == "code-reviewer-run-job"
    assert command[-2] == "--"


def test_the_container_command_limits_memory_without_swap_and_mounts_the_scripts_read_only() -> (
    None
):
    script = load_script()

    command = script.wrapper_command(
        count=1, concurrency=None, fake_llm=False, docker="image:tag", memory="2g"
    )

    assert command[:3] == ["docker", "run", "--rm"]
    assert command[command.index("--memory") + 1] == "2g"
    assert command[command.index("--memory-swap") + 1] == "2g"
    mount = command[command.index("--mount") + 1]
    assert mount.startswith("type=bind,source=") and mount.endswith("target=/measure,readonly")
    assert "image:tag" in command
    assert command[-2:] == ["--", "code-reviewer-run-job"]
    assert "-i" in command


def test_no_command_line_carries_a_secret(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")

    def mint(*args: str | Path) -> str:
        return TOKEN

    monkeypatch.setattr(script, "mint_installation_token", mint)
    seen: list[tuple[list[str], str]] = []

    def run(command: list[str], job: dict[str, Any], *rest: Any) -> tuple[int, str, str]:
        seen.append((command, json.dumps(job)))
        report: dict[str, Any] = {
            "children": [{"exitCode": 0, "wallMs": 1, "peakRssMb": 1.0, "result": {}}]
        }
        return 0, json.dumps(report), ""

    monkeypatch.setattr(script, "run_wrapper", run)

    script.main(["--size", "small", "--yes"])

    command, job = seen[0]
    assert TOKEN not in " ".join(command)
    assert API_KEY not in " ".join(command)
    assert TOKEN in job  # it travels on stdin only
    assert TOKEN not in capsys.readouterr().out


def test_a_secret_in_the_output_of_the_wrapper_stops_the_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")

    def mint(*args: str | Path) -> str:
        return TOKEN

    monkeypatch.setattr(script, "mint_installation_token", mint)

    def leaking(command: list[str], job: dict[str, Any], *rest: Any) -> tuple[int, str, str]:
        return 0, f"oops {TOKEN}", ""

    monkeypatch.setattr(script, "run_wrapper", leaking)

    code = script.main(["--size", "small", "--yes"])

    assert code == 2
    assert TOKEN not in capsys.readouterr().out


# CR-13-T04 (tool)
def child(rss: float, duration_ms: int, wall_ms: int, exit_code: int | None = 0, ok: bool = True):
    return {
        "exitCode": exit_code,
        "peakRssMb": rss,
        "wallMs": wall_ms,
        "cpuSeconds": 3.0,
        "result": {"ok": ok, "durationMs": duration_ms, "usage": {"costUsd": 0.01}},
    }


def test_repeated_runs_are_summarized_by_the_runners_own_duration() -> None:
    script = load_script()
    reports = [
        {"children": [child(400.0, 29_000, 31_000)]},
        {"children": [child(420.0, 49_000, 51_000)]},
        {"children": [child(410.0, 39_000, 41_000)]},
    ]

    summary = script.summarize(reports)

    assert summary["peakRssMb"] == {"min": 400.0, "median": 410.0, "max": 420.0}
    # durationMs of the runner (29, 39, 49 s), not the wrapper's wall time (31, 41, 51 s)
    assert summary["durationSeconds"] == {"min": 29.0, "median": 39.0, "max": 49.0}
    assert summary["runs"] == 3
    assert summary["failures"] == 0
    assert summary["costUsd"] == 0.03


def test_a_child_killed_by_the_oom_killer_is_counted_but_left_out_of_the_figures() -> None:
    script = load_script()
    killed = {"exitCode": None, "signal": "SIGKILL", "peakRssMb": 284.0, "wallMs": 5000}
    reports = [{"children": [child(320.0, 20_000, 21_000), killed]}]

    summary = script.summarize(reports)

    assert summary["killed"] == 1
    assert summary["failures"] == 1
    assert summary["peakRssMb"] == {"min": 320.0, "median": 320.0, "max": 320.0}
    assert summary["durationSeconds"] == {"min": 20.0, "median": 20.0, "max": 20.0}


def test_a_child_without_a_parseable_result_or_with_a_failed_one_counts_as_a_failure() -> None:
    script = load_script()
    no_result = {"exitCode": 0, "peakRssMb": 300.0, "wallMs": 1000, "result": None}
    reports = [{"children": [no_result, child(320.0, 20_000, 21_000, ok=False)]}]

    assert script.summarize(reports)["failures"] == 2


def test_the_exit_code_is_non_zero_after_a_batch_with_a_failed_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")

    def mint(*args: str | Path) -> str:
        return TOKEN

    monkeypatch.setattr(script, "mint_installation_token", mint)

    def run(command: list[str], job: dict[str, Any], *rest: Any) -> tuple[int, str, str]:
        report = {"children": [child(320.0, 1000, 1500, exit_code=1, ok=False)]}
        return 1, json.dumps(report), ""

    monkeypatch.setattr(script, "run_wrapper", run)

    assert script.main(["--size", "small", "--yes"]) == 1


@pytest.mark.parametrize(
    "arguments",
    [
        ["--count", "0"],
        ["--repeat", "0"],
        ["--concurrency", "0"],
        ["--count", "11"],
        ["--repeat", "11"],
        ["--concurrency", "11"],
    ],
)
def test_counts_outside_a_sane_range_are_refused_before_anything_starts(
    arguments: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    script = load_script()

    def must_not_run(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("must not be called")

    monkeypatch.setattr(script, "mint_installation_token", must_not_run)

    with pytest.raises(SystemExit) as stop:
        script.main(["--size", "small", "--yes", *arguments])

    assert stop.value.code == 2


# the real key never enters a run that must not spend money
def test_in_fake_llm_mode_the_job_carries_a_dummy_key_and_the_real_key_stays_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = load_script()
    for name in script.REQUIRED_ENV:
        monkeypatch.setenv(name, API_KEY if name == "OPENROUTER_API_KEY" else "1")

    def mint(*args: str | Path) -> str:
        return TOKEN

    monkeypatch.setattr(script, "mint_installation_token", mint)
    jobs: list[str] = []

    def run(command: list[str], job: dict[str, Any], *rest: Any) -> tuple[int, str, str]:
        jobs.append(json.dumps(job))
        report = {"children": [child(320.0, 1000, 1500)]}
        return 0, json.dumps(report), ""

    monkeypatch.setattr(script, "run_wrapper", run)

    script.main(["--size", "small", "--yes", "--fake-llm"])
    script.main(["--size", "small", "--yes"])

    assert API_KEY not in jobs[0]
    assert script.FAKE_LLM_KEY in jobs[0]
    assert API_KEY in jobs[1]


def test_the_prompt_without_the_confirmation_says_that_the_review_comment_is_overwritten(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    script = load_script()

    assert script.main(["--size", "small", "--fake-llm"]) == 2

    printed = capsys.readouterr().out
    assert "overwrites" in printed
    assert "--yes" in printed


def test_a_secret_is_found_even_if_only_the_beginning_or_the_end_of_it_survived_a_cut() -> None:
    script = load_script()
    secret = "ghs_0123456789abcdefghijklmnopqrstuvwxyz"

    assert script.leaks([secret], f"... {secret[:15]}") is True
    assert script.leaks([secret], f"{secret[-15:]} ...") is True
    assert script.leaks([secret], "nothing here") is False
    assert script.leaks(["short"], "short") is False  # too short to be a fragment, ignored


def test_a_timeout_kills_the_named_container_and_still_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import subprocess

    script = load_script()
    calls: list[list[str]] = []

    def fake_run(command: list[str], *args: Any, **kwargs: Any) -> Any:
        calls.append(command)
        if command[0] == "docker" and command[1] == "run":
            raise subprocess.TimeoutExpired(command, 1)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(script.subprocess, "run", fake_run)

    with pytest.raises(subprocess.TimeoutExpired):
        script.run_wrapper(["docker", "run", "--name", "cr-x"], {}, container="cr-x")

    assert ["docker", "kill", "cr-x"] in calls


def test_a_container_is_named_so_that_it_can_be_killed() -> None:
    script = load_script()

    command = script.wrapper_command(
        count=1, concurrency=None, fake_llm=False, docker="image:tag", container="cr-measure-1"
    )

    assert command[command.index("--name") + 1] == "cr-measure-1"
