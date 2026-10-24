# SPDX-License-Identifier: LicenseRef-Proprietary

"""The startup every entry mode runs once at container start (#324).

`run_startup` is the one sequence: remove the verdict of an earlier start, set up the network and
drop `NET_ADMIN` (`prepare_dynamic_runtime`), decide the advertised engines (`advertise_engines`),
write the verdict. The steps themselves are pinned elsewhere; here the order, the verdict and what
a failing step leaves behind.
"""

from typing import Any

import pytest

from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_DIFF
from code_reviewer_runner.dynamic_review.netguard import EgressMode, IsolationError
from code_reviewer_runner.dynamic_review.self_check import SelfCheckFailed, SelfCheckReason
from code_reviewer_runner.dynamic_review.static_isolation import EgressSetup
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.settings import (
    LoopSettings,
    WorkerSettings,
    settings_from_environment,
    worker_settings_from_environment,
)
from code_reviewer_runner.verdict import Verdict

DYNAMIC = {"RUNNER_DIFF_JOB_USER": "10001:10001"}
LOOP = {
    "RUNNER_API_URL": "http://app:3000",
    "RUNNER_TOKEN": "dummy-runner-token-0123456789",
    **DYNAMIC,
}


class Steps:
    """Records the order of the steps; each can be told to fail."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.events: list[str] = []
        self.written: list[Verdict] = []
        self.check_facts: list[dict[str, Any]] = []
        self.rules_installed = True
        self.cannot_drop = False
        self.failing_reason: SelfCheckReason | None = None
        monkeypatch.setattr(service, "prepare_dynamic_runtime", self.prepare)
        monkeypatch.setattr(service, "check_dynamic_runner", self.check)

    def prepare(self, settings: LoopSettings | WorkerSettings) -> EgressSetup:
        self.events.append("prepare")
        if self.cannot_drop:
            raise IsolationError("a capability could not be dropped from the bounding set")
        return EgressSetup(self.rules_installed, EgressMode.FULL)

    def check(self, **facts: Any) -> None:
        self.events.append("check")
        self.check_facts.append(facts)
        if self.failing_reason is not None:
            raise SelfCheckFailed(self.failing_reason, "a property does not hold")

    def remove(self) -> None:
        self.events.append("remove")

    def write(self, verdict: Verdict) -> str | None:
        self.events.append("write")
        self.written.append(verdict)
        return None

    def run[Settings: (LoopSettings, WorkerSettings)](
        self, settings: Settings, **options: Any
    ) -> tuple[Settings, Verdict]:
        return service.run_startup(
            settings, remove_verdict=self.remove, write_verdict=self.write, **options
        )


@pytest.fixture
def steps(monkeypatch: pytest.MonkeyPatch) -> Steps:
    return Steps(monkeypatch)


# #324-T06: the old verdict goes first, the new one is written last.
def test_the_startup_removes_the_old_verdict_sets_up_the_network_checks_and_writes_the_verdict(
    steps: Steps,
) -> None:
    settings, verdict = steps.run(settings_from_environment(LOOP))

    assert steps.events == ["remove", "prepare", "check", "write"]
    assert settings.engines == ALL_ENGINES
    assert verdict == Verdict(ALL_ENGINES)
    assert steps.written == [verdict]


# #324-T02
@pytest.mark.parametrize("reason", list(SelfCheckReason))
def test_a_failed_check_leaves_pr_agent_and_the_stable_reason_in_the_verdict(
    steps: Steps, reason: SelfCheckReason
) -> None:
    steps.failing_reason = reason

    settings, verdict = steps.run(worker_settings_from_environment(DYNAMIC))

    assert settings.engines == (ENGINE_DIFF,)
    assert verdict == Verdict((ENGINE_DIFF,), (reason.value,))
    assert steps.written == [verdict]


# #324-T03: a runner without an engine user can never advertise opencode.
def test_a_runner_without_an_engine_user_is_pr_agent_only_with_the_reason_named(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def installed(settings: LoopSettings | WorkerSettings) -> EgressSetup:
        return EgressSetup(True, EgressMode.FULL)

    monkeypatch.setattr(service, "prepare_dynamic_runtime", installed)
    written: list[Verdict] = []

    settings, verdict = service.run_startup(
        worker_settings_from_environment({}),
        remove_verdict=lambda: None,
        write_verdict=lambda found: written.append(found),
    )

    assert settings.engines == (ENGINE_DIFF,)
    assert verdict == Verdict((ENGINE_DIFF,), (SelfCheckReason.NOT_A_DYNAMIC_RUNNER.value,))


# #324-T02: a start that cannot end NET_ADMIN refuses to go on, and leaves no verdict.
def test_a_startup_that_cannot_drop_the_capabilities_raises_and_writes_nothing(
    steps: Steps,
) -> None:
    steps.cannot_drop = True

    with pytest.raises(IsolationError):
        steps.run(worker_settings_from_environment(DYNAMIC))

    assert steps.events == ["remove", "prepare"]
    assert steps.written == []


# #324-T02: the rules that could not be installed are the reason, not a crash.
def test_rules_that_were_not_installed_are_the_reason_in_the_verdict(steps: Steps) -> None:
    steps.rules_installed = False
    steps.failing_reason = SelfCheckReason.NETWORK_RULES_NOT_INSTALLED

    _, verdict = steps.run(worker_settings_from_environment(DYNAMIC))

    assert verdict.reasons == ("network_rules_not_installed",)
    assert steps.check_facts[0]["rules_installed"] is False


# #324-T02: the entry modes of the Worker image ask for a read-only root, the legacy loop does not.
def test_the_read_only_root_is_asked_of_the_check_only_when_the_mode_requires_it(
    steps: Steps,
) -> None:
    steps.run(worker_settings_from_environment(DYNAMIC))
    steps.run(worker_settings_from_environment(DYNAMIC), require_read_only_root=True)

    assert "root_read_only" not in steps.check_facts[0]
    assert callable(steps.check_facts[1]["root_read_only"])


# #324-T08: unchanged behaviour of the existing function for its existing callers.
def test_advertise_engines_still_returns_only_the_settings(steps: Steps) -> None:
    settings = service.advertise_engines(settings_from_environment(LOOP), True)

    assert settings.engines == ALL_ENGINES
