# SPDX-License-Identifier: LicenseRef-Proprietary

"""The measuring wrapper of the CR-13 spike as real processes: it runs a command (or several at
once) and reports the peak memory and the duration of each."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "measure_child.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("measure_child", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["measure_child"] = module
    spec.loader.exec_module(module)
    return module


def run_wrapper(
    *arguments: str, child: str, stdin: str = "{}"
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any]]:
    process = subprocess.run(
        [sys.executable, str(SCRIPT), *arguments, "--", sys.executable, "-c", child],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=50,
        check=False,
    )
    lines = process.stdout.splitlines()
    assert len(lines) == 1, process.stdout + process.stderr
    return process, json.loads(lines[0])


def test_a_child_is_measured_and_its_result_line_is_parsed() -> None:
    process, report = run_wrapper(child="print('{\"ok\": true}')")

    children: list[dict[str, Any]] = report["children"]
    assert len(children) == 1
    child = children[0]
    assert child["exitCode"] == 0
    assert child["result"] == {"ok": True}
    assert child["peakRssMb"] > 5
    assert child["wallMs"] >= 0
    assert process.returncode == 0


def test_the_child_gets_the_job_on_stdin() -> None:
    _, report = run_wrapper(
        child="import sys; print('JOB ' + sys.stdin.read())", stdin='{"hello": 1}'
    )

    child: dict[str, Any] = report["children"][0]
    assert child["resultText"].strip() == 'JOB {"hello": 1}'
    assert child["result"] is None


# CR-13-T05 (tool)
def test_several_children_run_at_the_same_time_each_with_its_own_numbers() -> None:
    child = "import time; time.sleep(2.0); print('{\"ok\": true}')"

    process, report = run_wrapper("--count", "3", child=child)

    children: list[dict[str, Any]] = report["children"]
    assert len(children) == 3
    assert [c["index"] for c in children] == [0, 1, 2]
    # three two-second sleeps one after the other would take six seconds or more
    assert report["wallMs"] < 5500
    assert process.returncode == 0


def test_a_failing_child_makes_the_wrapper_exit_non_zero_but_still_reports() -> None:
    process, report = run_wrapper(child="import sys; sys.exit(3)")

    assert report["children"][0]["exitCode"] == 3
    assert process.returncode == 1


def test_a_child_killed_by_a_signal_is_reported_with_the_signal_name() -> None:
    _, report = run_wrapper(child="import os, signal; os.kill(os.getpid(), signal.SIGKILL)")

    child: dict[str, Any] = report["children"][0]
    assert child["exitCode"] is None
    assert child["signal"] == "SIGKILL"


def test_the_fake_llm_mode_points_the_job_at_the_loopback_server() -> None:
    job = json.dumps({"llm": {"provider": "openrouter", "model": "x/y", "apiKey": "k"}})

    _, report = run_wrapper(
        "--fake-llm",
        child="import sys, json; print(json.dumps(json.load(sys.stdin)['llm']))",
        stdin=job,
    )

    llm: dict[str, Any] = report["children"][0]["result"]
    assert llm["baseUrl"].startswith("http://127.0.0.1:")
    assert llm["apiKey"] == "k"


@pytest.mark.parametrize("bad", ["", "not json"])
def test_stdout_of_a_child_that_is_no_json_is_kept_as_text(bad: str) -> None:
    _, report = run_wrapper(child=f"print({bad!r})")

    child: dict[str, Any] = report["children"][0]
    assert child["result"] is None
    assert child["resultText"].strip() == bad


# CR-13-T01 (tool): the CPU time is part of the server sizing
def test_the_cpu_time_of_a_busy_child_is_reported_in_seconds() -> None:
    _, report = run_wrapper(
        child="import time; end = time.process_time() + 0.5\nwhile time.process_time() < end: pass"
    )

    child: dict[str, Any] = report["children"][0]
    assert 0.4 <= child["cpuSeconds"] < 5


def test_a_secret_of_the_job_is_redacted_before_the_text_is_cut() -> None:
    token = "tok-0123456789abcdef"
    job = json.dumps({"git": {"token": token}, "llm": {"apiKey": "key-0123456789abcdef"}})
    # Not JSON, so the raw text is kept; the token sits right at the cut (the last 2000 characters).
    child = (
        f"import sys; sys.stdout.write('x' * 1990 + {token!r} + 'y' * 5); "
        f"sys.stderr.write({token!r})"
    )

    _, report = run_wrapper(child=child, stdin=job)

    child_report: dict[str, Any] = report["children"][0]
    assert token not in json.dumps(report)
    assert token[:8] not in child_report["resultText"]
    assert "[REDACTED]" in child_report["resultText"]
    assert "[REDACTED]" in child_report["stderrTail"]
