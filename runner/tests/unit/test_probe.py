# SPDX-License-Identifier: Apache-2.0

"""The `probe` entry mode (#324): the startup self-check, then one line of JSON and exit.

No secret is involved: the mode reads no token, no URL and no credential, and prints engines and
stable reasons only. The startup is the real sequence of `service.run_startup` with the network
setup and the check replaced by doubles.
"""

import io
import json
from typing import Any

import pytest

from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_DIFF
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.self_check import (
    SelfCheckFailed,
    SelfCheckReason,
    check_dynamic_runner,
)
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.settings import LoopSettings, WorkerSettings
from code_reviewer_runner.probe import run_probe

DYNAMIC = {"RUNNER_DIFF_JOB_USER": "10001:10001"}
SECRETS = {
    "RUNNER_TOKEN": "dummy-runner-token-0123456789-abcdef",
    "OPENROUTER_API_KEY": "sk-or-dummy-0123456789",
    "GITHUB_TOKEN": "ghs_dummy0123456789",
}


class World:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.reason: SelfCheckReason | None = None
        self.cannot_drop = False
        self.facts: list[dict[str, Any]] = []
        self.written = 0
        monkeypatch.setattr(service, "prepare_dynamic_runtime", self.prepare)
        monkeypatch.setattr(service, "check_dynamic_runner", self.check)
        monkeypatch.setattr(service, "write_engines_file", self.write)
        monkeypatch.setattr(service, "remove_engines_file", lambda: None)

    def prepare(self, settings: LoopSettings | WorkerSettings) -> bool:
        if self.cannot_drop:
            raise IsolationError("a capability could not be dropped from the bounding set")
        return True

    def check(self, **facts: Any) -> None:
        self.facts.append(facts)
        if self.reason is not None:
            raise SelfCheckFailed(self.reason, "a property does not hold")

    def write(self, verdict: Any) -> None:
        self.written += 1


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> World:
    return World(monkeypatch)


def probe(environment: dict[str, str]) -> tuple[int, str]:
    out = io.StringIO()
    code = run_probe(environment, stdout=out)
    return code, out.getvalue()


# #324-T01
def test_a_hardened_dynamic_container_prints_both_engines_and_exits_with_zero(
    world: World,
) -> None:
    code, out = probe(DYNAMIC)

    assert code == 0
    assert out.count("\n") == 1 and out.endswith("\n")
    assert json.loads(out) == {"version": 1, "engines": list(ALL_ENGINES), "reasons": []}


# #324-T01: the probe asks for what the Worker modes ask for.
def test_the_probe_asks_for_a_read_only_root(world: World) -> None:
    probe(DYNAMIC)

    assert callable(world.facts[0]["root_read_only"])


# #324-T02
@pytest.mark.parametrize(
    "reason",
    [
        SelfCheckReason.NOT_ROOT_SUPERVISOR,
        SelfCheckReason.NETWORK_RULES_NOT_INSTALLED,
        SelfCheckReason.CAPABILITIES_NOT_DROPPED,
        SelfCheckReason.ROOT_FILESYSTEM_WRITABLE,
        SelfCheckReason.ENGINE_BINARY_MISSING,
    ],
)
def test_a_failed_property_is_pr_agent_only_with_the_stable_reason(
    world: World, reason: SelfCheckReason
) -> None:
    world.reason = reason

    code, out = probe(DYNAMIC)

    assert code == 0  # the verdict is the answer, not the exit status
    assert json.loads(out) == {"version": 1, "engines": [ENGINE_DIFF], "reasons": [reason.value]}


# #324-T02: a container that cannot end its startup capabilities is a verdict as well.
def test_capabilities_that_cannot_be_dropped_are_a_verdict_and_not_a_crash(world: World) -> None:
    world.cannot_drop = True

    code, out = probe(DYNAMIC)

    assert code == 0
    assert json.loads(out) == {
        "version": 1,
        "engines": [ENGINE_DIFF],
        "reasons": ["capabilities_not_dropped"],
    }
    assert world.written == 0


# #324-T03
def test_a_container_without_an_engine_user_never_advertises_opencode(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(service, "check_dynamic_runner", check_dynamic_runner)  # the real check

    code, out = probe({})

    assert code == 0
    verdict = json.loads(out)
    assert verdict["engines"] == [ENGINE_DIFF]
    assert verdict["reasons"] == ["not_a_dynamic_runner"]


# #324-T02: no value of the environment is in the output, the log or the verdict.
def test_nothing_of_the_environment_is_printed_or_logged(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    world.reason = SelfCheckReason.ENGINE_VERSION_MISMATCH

    code, out = probe({**DYNAMIC, **SECRETS})

    captured = capsys.readouterr()
    assert code == 0
    for secret in SECRETS.values():
        assert secret not in out + captured.out + captured.err
    assert set(json.loads(out)) == {"version", "engines", "reasons"}


# #324-T06: the probe leaves the verdict where a launcher in the container finds it.
def test_the_probe_writes_the_engines_file_like_every_mode(world: World) -> None:
    probe(DYNAMIC)

    assert world.written == 1


def test_unusable_settings_are_a_setup_error_that_prints_no_verdict(
    world: World, capsys: pytest.CaptureFixture[str]
) -> None:
    code, out = probe({"RUNNER_JOB_TIMEOUT_SECONDS": "soon"})

    assert code == 2
    assert out == ""
    assert "RUNNER_JOB_TIMEOUT_SECONDS" in capsys.readouterr().err
