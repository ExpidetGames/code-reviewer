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
    mount = command[command.index("-v") + 1]
    assert mount.endswith(":/measure:ro")
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

    def run(command: list[str], job: dict[str, Any]) -> tuple[int, str, str]:
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

    def leaking(command: list[str], job: dict[str, Any]) -> tuple[int, str, str]:
        return 0, f"oops {TOKEN}", ""

    monkeypatch.setattr(script, "run_wrapper", leaking)

    code = script.main(["--size", "small", "--yes"])

    assert code == 2
    assert TOKEN not in capsys.readouterr().out


# CR-13-T04 (tool)
def test_repeated_runs_are_summarized_as_minimum_median_and_maximum() -> None:
    script = load_script()
    reports = [
        {
            "children": [
                {
                    "exitCode": 0,
                    "peakRssMb": 400.0,
                    "wallMs": 30_000,
                    "result": {"durationMs": 29_000},
                }
            ]
        },
        {
            "children": [
                {
                    "exitCode": 0,
                    "peakRssMb": 420.0,
                    "wallMs": 50_000,
                    "result": {"durationMs": 49_000},
                }
            ]
        },
        {
            "children": [
                {
                    "exitCode": 0,
                    "peakRssMb": 410.0,
                    "wallMs": 40_000,
                    "result": {"durationMs": 39_000},
                }
            ]
        },
    ]

    summary = script.summarize(reports)

    assert summary["peakRssMb"] == {"min": 400.0, "median": 410.0, "max": 420.0}
    assert summary["wallSeconds"] == {"min": 30.0, "median": 40.0, "max": 50.0}
    assert summary["runs"] == 3
    assert summary["failures"] == 0
