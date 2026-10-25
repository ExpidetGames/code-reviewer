# SPDX-License-Identifier: LicenseRef-Proprietary

"""The entry modes of the image: `code-reviewer-runner [legacy|dispatch|worker-once|probe]` (#324).

The mode is the argument; without one it is `RUNNER_MODE`, and without that `legacy`, the job loop
as it always was. The modes themselves are pinned in their own tests; here the choice.
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
        monkeypatch.setattr(cli, "run_from_environment", self.mode("legacy"))
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


# #324-T08
def test_without_a_mode_the_legacy_loop_starts_as_before(calls: Calls) -> None:
    assert cli.main([], environment={"RUNNER_API_URL": "http://app:3000"}) == 0

    assert [name for name, _ in calls.calls] == ["legacy"]
    # The loop gets the environment it always got.
    assert calls.calls[0][1] == {"RUNNER_API_URL": "http://app:3000"}


# #324-T08
def test_runner_mode_legacy_is_the_same_as_no_mode(calls: Calls) -> None:
    cli.main([], environment={"RUNNER_MODE": "legacy"})

    assert [name for name, _ in calls.calls] == ["legacy"]


# #324-T08: an empty variable (a compose file with `RUNNER_MODE:` and no value) is the default.
def test_an_empty_runner_mode_is_the_default(calls: Calls) -> None:
    cli.main([], environment={"RUNNER_MODE": "  "})

    assert [name for name, _ in calls.calls] == ["legacy"]


# #324-T01
@pytest.mark.parametrize("mode", ["probe", "worker-once", "legacy"])
def test_the_argument_selects_the_mode(calls: Calls, mode: str) -> None:
    assert cli.main([mode], environment={}) == 0

    assert [name for name, _ in calls.calls] == [mode]


def test_the_argument_wins_over_the_variable(calls: Calls) -> None:
    cli.main(["probe"], environment={"RUNNER_MODE": "legacy"})

    assert [name for name, _ in calls.calls] == ["probe"]


def test_the_variable_selects_the_mode_without_an_argument(calls: Calls) -> None:
    cli.main([], environment={"RUNNER_MODE": "worker-once"})

    assert [name for name, _ in calls.calls] == ["worker-once"]


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


# #324-T08
def test_an_unknown_runner_mode_is_refused_naming_the_variable_and_not_its_value(
    calls: Calls, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main([], environment={"RUNNER_MODE": SECRET}) == 2

    captured = capsys.readouterr()
    assert "RUNNER_MODE" in captured.err
    assert SECRET not in captured.out + captured.err
    assert calls.calls == []


# #324-T08: this image carries no Dispatcher bundle yet; the mode is named and refuses cleanly.
def test_dispatch_without_a_dispatcher_bundle_refuses_with_a_stable_code(
    calls: Calls, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["dispatch"], environment={}) == 2

    assert "dispatcher_bundle_missing" in capsys.readouterr().err
    assert calls.calls == []


def test_the_version_flag_is_still_answered_before_any_mode(
    calls: Calls, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli.main(["--version"], environment={"RUNNER_MODE": "probe"}) == 0

    assert capsys.readouterr().out.startswith("code-reviewer-runner ")
    assert calls.calls == []
