# SPDX-License-Identifier: LicenseRef-Proprietary

"""The entry modes of the image: `code-reviewer-runner <worker-once|probe>` (#324).

The mode is the argument and is required (there is no job loop any more). The modes themselves are
pinned in their own tests; here the choice.
"""

import io
from collections.abc import Mapping
from typing import Any

import pytest

from code_reviewer_runner import cli

SECRET = "crj_" + "Zq3_-" * 8 + "Zq3"


class Calls:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.stdin: list[object] = []
        monkeypatch.setattr(cli, "run_probe", self.mode("probe"))
        monkeypatch.setattr(cli, "run_worker_once", self.mode("worker-once"))

    def mode(self, name: str) -> Any:
        def run(environment: Mapping[str, str], *rest: Any, **options: Any) -> int:
            self.calls.append((name, dict(environment)))
            self.stdin.append(options.get("stdin"))
            return 0

        return run


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> Calls:
    return Calls(monkeypatch)


# #324-T01
@pytest.mark.parametrize("mode", ["probe", "worker-once"])
def test_the_argument_selects_the_mode(calls: Calls, mode: str) -> None:
    assert cli.main([mode], environment={}) == 0

    assert [name for name, _ in calls.calls] == [mode]


# #324-T08: the environment does not choose a mode.
def test_a_variable_does_not_select_a_mode_without_an_argument(
    calls: Calls, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main([], environment={"RUNNER_MODE": "worker-once"}) == 2

    assert calls.calls == []
    assert "usage:" in capsys.readouterr().err


# #324-T04: the start document reaches the Worker on stdin and nowhere else.
def test_worker_once_is_given_stdin_and_no_argument(calls: Calls) -> None:
    stdin = io.StringIO('{"credential": "' + SECRET + '"}')

    cli.main(["worker-once"], environment={}, stdin=stdin)

    assert calls.stdin == [stdin]


# #324-T08
def test_an_unknown_mode_is_a_usage_error_that_does_not_echo_it(
    calls: Calls, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main([SECRET], environment={}) == 2

    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err
    assert "usage:" in captured.err
    assert calls.calls == []


# #324-T08: a mode this image no longer has is an unknown one.
@pytest.mark.parametrize("mode", ["legacy", "dispatch"])
def test_the_retired_modes_are_refused(
    calls: Calls, capsys: pytest.CaptureFixture[str], mode: str
) -> None:
    assert cli.main([mode], environment={}) == 2

    assert "usage:" in capsys.readouterr().err
    assert calls.calls == []


def test_the_version_flag_is_still_answered_before_any_mode(
    calls: Calls, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["--version"], environment={"RUNNER_MODE": "probe"}) == 0

    assert capsys.readouterr().out.startswith("code-reviewer-runner ")
    assert calls.calls == []
