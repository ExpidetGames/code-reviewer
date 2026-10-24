# SPDX-License-Identifier: LicenseRef-Proprietary

"""`worker-reap` (#324): the engine-user sweep of the image, for the launchers.

A launcher that ends a Worker's process group (it owns the group's leader, so it can do so without
ever signalling a group id that is no longer its own, see `process_group.py`) then runs this to end
what the engine user still runs: a helper that left the group with `setsid()`. It never signals a
process group itself.
"""

import pytest

from code_reviewer_runner import worker_reap
from code_reviewer_runner.dynamic_review import engine_user
from code_reviewer_runner.dynamic_review.engine_user import SweepUnavailable

DYNAMIC = {"RUNNER_DIFF_JOB_USER": "10001:10001"}


class Sweeper:
    def __init__(self, ended: bool = True) -> None:
        self.ended = ended
        self.calls: list[tuple[int, int]] = []

    def __call__(self, uid: int, gid: int) -> bool:
        self.calls.append((uid, gid))
        return self.ended


def as_root() -> int:
    return 0


def as_user() -> int:
    return 10001


# #324-T10
def test_the_engine_user_is_swept_and_zero_means_nothing_of_it_runs_any_more() -> None:
    sweeper = Sweeper()

    code = worker_reap.run(DYNAMIC, sweeper=sweeper, euid=as_root)

    assert code == worker_reap.REAPED
    assert sweeper.calls == [(10101, 10101)]


# #324-T10
def test_the_engine_user_comes_from_the_same_variables_as_the_runner_reads() -> None:
    sweeper = Sweeper()

    worker_reap.run(
        {**DYNAMIC, "RUNNER_DYNAMIC_ENGINE_UID": "20202", "RUNNER_DYNAMIC_ENGINE_GID": "20203"},
        sweeper=sweeper,
        euid=as_root,
    )

    assert sweeper.calls == [(20202, 20203)]


# #324-T10
def test_a_process_that_survived_the_sweep_is_exit_one() -> None:
    code = worker_reap.run(DYNAMIC, sweeper=Sweeper(ended=False), euid=as_root)

    assert code == worker_reap.SURVIVORS


# #324-T10: a container without an engine user (Diff only) has nothing to reap.
def test_a_container_without_an_engine_user_has_nothing_to_reap() -> None:
    sweeper = Sweeper()

    code = worker_reap.run({}, sweeper=sweeper, euid=as_root)

    assert code == worker_reap.REAPED
    assert sweeper.calls == []


# #324-T10: the sweep needs the right to become the engine user; without it, say so and stop.
def test_a_process_that_is_not_root_cannot_sweep_and_says_so(
    capsys: pytest.CaptureFixture[str],
) -> None:
    sweeper = Sweeper()

    code = worker_reap.run(DYNAMIC, sweeper=sweeper, euid=as_user)

    assert code == worker_reap.SETUP_ERROR
    assert sweeper.calls == []
    assert "not_root_supervisor" in capsys.readouterr().err


# #324-T10
def test_unusable_settings_are_a_setup_error_that_names_the_variable(
    capsys: pytest.CaptureFixture[str],
) -> None:
    code = worker_reap.run(
        {**DYNAMIC, "RUNNER_DYNAMIC_ENGINE_UID": "0"}, sweeper=Sweeper(), euid=as_root
    )

    assert code == worker_reap.SETUP_ERROR
    assert "RUNNER_DYNAMIC_ENGINE_UID" in capsys.readouterr().err


# #324-T10: no argument can name a process or a group; nothing but --version and --help exist.
def test_worker_reap_accepts_no_target(capsys: pytest.CaptureFixture[str]) -> None:
    assert worker_reap.main(["--pgid", "1"], environment=DYNAMIC) == worker_reap.SETUP_ERROR

    assert "usage:" in capsys.readouterr().err


# #324 (review of #351): a sweep that could not be made is not "a process survived".
def test_a_sweep_that_could_not_be_made_is_a_setup_error_and_not_survivors(
    capsys: pytest.CaptureFixture[str],
) -> None:
    def cannot_sweep(uid: int, gid: int) -> bool:
        raise SweepUnavailable("the sweep tool is not installed")

    code = worker_reap.run(DYNAMIC, sweeper=cannot_sweep, euid=as_root)

    assert code == worker_reap.SETUP_ERROR
    assert "sweep_unavailable" in capsys.readouterr().err


# #324 (review of #351): the real sweep says so when it has no python3 or the subprocess raises.
def test_the_real_sweep_raises_when_it_cannot_run_and_the_boolean_form_still_says_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def one_process(uid: int) -> list[int]:
        return [4242]

    def no_python(cmd: str, *, path: str | None = None) -> str | None:
        return None

    def python(cmd: str, *, path: str | None = None) -> str | None:
        return "/usr/bin/python3"

    def refuses(*args: object, **kwargs: object) -> None:
        raise PermissionError("not allowed")

    monkeypatch.setattr(engine_user, "user_pids", one_process)
    monkeypatch.setattr(engine_user.shutil, "which", no_python)
    with pytest.raises(SweepUnavailable):
        engine_user.try_sweep_user(10101, 10101)
    assert engine_user.sweep_user(10101, 10101) is False

    monkeypatch.setattr(engine_user.shutil, "which", python)
    monkeypatch.setattr(engine_user.subprocess, "run", refuses)
    with pytest.raises(SweepUnavailable):
        engine_user.try_sweep_user(10101, 10101)
    assert engine_user.sweep_user(10101, 10101) is False
