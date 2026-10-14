# SPDX-License-Identifier: Apache-2.0

"""The job loop advertises `opencode` only when the startup self-check passed (#202).

The check itself is pinned in `test_dynamic_review_self_check.py`; here the loop's use of it: when
it runs, what it changes in the settings, what it logs, and that a runner without an engine user
(every runner that is not the Dynamic runner) can never pass.
"""

import logging
from typing import Any

import pytest

from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_DIFF, ENGINE_DYNAMIC
from code_reviewer_runner.dynamic_review.self_check import (
    DEFAULT_TOOLS,
    SelfCheckFailed,
    SelfCheckReason,
)
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.service import advertise_engines
from code_reviewer_runner.job_loop.settings import LoopSettings, settings_from_environment

PORTS = SlotPorts(10180, 10181)
BASE = {"RUNNER_API_URL": "http://app:3000", "RUNNER_TOKEN": "dummy-runner-token-0123456789"}
DYNAMIC_RUNNER = {**BASE, "RUNNER_DIFF_JOB_USER": "10001:10001"}


def dynamic_settings() -> LoopSettings:
    return settings_from_environment(DYNAMIC_RUNNER)


# #202-T01
def test_a_passing_check_advertises_both_engines_and_names_the_verified_command(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: list[dict[str, Any]] = []

    def passing(**facts: Any) -> None:
        seen.append(facts)

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        settings = advertise_engines(dynamic_settings(), True, check=passing)

    assert settings.engines == ALL_ENGINES
    assert settings.dynamic_command == (str(DEFAULT_TOOLS.opencode),)
    assert settings.dynamic_ripgrep == str(DEFAULT_TOOLS.ripgrep)
    assert seen == [{"user": (10101, 10101), "ports": PORTS, "rules_installed": True}]
    assert "advertised" in caplog.text and "opencode" in caplog.text


# #202-T09: the stable reason is in the log, and no value.
@pytest.mark.parametrize("reason", list(SelfCheckReason))
def test_a_failed_check_never_advertises_and_logs_the_reason(
    caplog: pytest.LogCaptureFixture, reason: SelfCheckReason
) -> None:
    def failing(**facts: Any) -> None:
        raise SelfCheckFailed(reason, "a property does not hold")

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        settings = advertise_engines(dynamic_settings(), True, check=failing)

    assert settings.engines == (ENGINE_DIFF,)
    assert ENGINE_DYNAMIC not in settings.engines
    assert settings.dynamic_command is None
    assert settings.dynamic_ripgrep is None
    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "not advertised" in warnings[0].getMessage()
    assert reason.value in warnings[0].getMessage()
    assert "dynamic_isolation_self_check_failed" in warnings[0].getMessage()


# #202-T09: rules that could not be installed are passed on to the check.
def test_the_outcome_of_the_network_setup_reaches_the_check() -> None:
    seen: list[bool] = []

    def record(**facts: Any) -> None:
        seen.append(facts["rules_installed"])

    advertise_engines(dynamic_settings(), False, check=record)

    assert seen == [False]


# #202-T09: an error nobody expected is still "not advertised", never a crash of the runner.
def test_an_unexpected_error_in_the_check_does_not_advertise_or_stop_the_runner() -> None:
    def broken(**facts: Any) -> None:
        raise MemoryError("boom")

    settings = advertise_engines(dynamic_settings(), True, check=broken)

    assert settings.engines == (ENGINE_DIFF,)


# #202-T03: the default runner has no engine user; the real check refuses it before anything else.
def test_a_runner_without_an_engine_user_never_advertises_opencode(
    caplog: pytest.LogCaptureFixture,
) -> None:
    settings = settings_from_environment(BASE)

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        advertised = advertise_engines(settings, True)

    assert advertised.engines == (ENGINE_DIFF,)
    assert advertised.dynamic_command is None
    assert "not_a_dynamic_runner" in caplog.text
    # A Diff runner is working as designed: this is information, not a warning.
    assert not [record for record in caplog.records if record.levelno >= logging.WARNING]


# #202-T09: the real check on the real host (not root, no image) fails closed with a reason.
def test_the_real_check_on_a_host_that_is_not_the_dynamic_image_fails_closed() -> None:
    advertised = advertise_engines(dynamic_settings(), True)

    assert advertised.engines == (ENGINE_DIFF,)


# #202-T01: the startup order of the runner: network setup first, then the check, then the loop.
def test_the_runner_sets_up_the_network_then_checks_then_serves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []
    served: list[LoopSettings] = []

    def prepare(settings: LoopSettings) -> bool:
        events.append("prepare")
        return True

    def check(**facts: Any) -> None:
        events.append("check")

    async def serve(settings: LoopSettings, environment: Any, **options: Any) -> int:
        events.append("serve")
        served.append(settings)
        return 0

    monkeypatch.setattr(service, "prepare_dynamic_runtime", prepare)
    monkeypatch.setattr(service, "check_dynamic_runner", check)
    monkeypatch.setattr(service, "serve", serve)

    assert service.run_from_environment(DYNAMIC_RUNNER) == 0

    assert events == ["prepare", "check", "serve"]
    assert served[0].engines == ALL_ENGINES


def installed(settings: LoopSettings) -> bool:
    return True


# #202-T09: a check that fails still lets the runner serve Diff jobs.
def test_a_runner_whose_check_failed_still_serves_diff_jobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    served: list[LoopSettings] = []

    def check(**facts: Any) -> None:
        raise SelfCheckFailed(SelfCheckReason.ENGINE_BINARY_MISSING, "a required tool is missing")

    async def serve(settings: LoopSettings, environment: Any, **options: Any) -> int:
        served.append(settings)
        return 0

    monkeypatch.setattr(service, "prepare_dynamic_runtime", installed)
    monkeypatch.setattr(service, "check_dynamic_runner", check)
    monkeypatch.setattr(service, "serve", serve)

    assert service.run_from_environment(DYNAMIC_RUNNER) == 0
    assert served[0].engines == (ENGINE_DIFF,)


# #264-T06: the Dynamic runner of compose.coolify.yml shares its host with the app and Diff runner.
# A host without nf_tables (the rules cannot be installed) leaves that runner serving Diff jobs
# only, with the stable reason in its log; nothing else about the deployment depends on it.
def test_a_host_without_nf_tables_leaves_a_runner_that_serves_diff_jobs_and_names_why(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    served: list[LoopSettings] = []

    def rules_not_installed(settings: LoopSettings) -> bool:
        return False  # `secure_startup` returns False when `nft` cannot install the rules

    def check(**facts: Any) -> None:
        if not facts["rules_installed"]:
            raise SelfCheckFailed(SelfCheckReason.NETWORK_RULES_NOT_INSTALLED, "no rules")

    async def serve(settings: LoopSettings, environment: Any, **options: Any) -> int:
        served.append(settings)
        return 0

    monkeypatch.setattr(service, "prepare_dynamic_runtime", rules_not_installed)
    monkeypatch.setattr(service, "check_dynamic_runner", check)
    monkeypatch.setattr(service, "serve", serve)

    # The loop's logger writes to stderr and does not propagate: read what an operator would read.
    assert service.run_from_environment(DYNAMIC_RUNNER) == 0

    assert served[0].engines == (ENGINE_DIFF,)
    assert served[0].dynamic_command is None
    message = capsys.readouterr().err
    assert "opencode is not advertised, this runner serves Diff jobs only" in message
    assert SelfCheckReason.NETWORK_RULES_NOT_INSTALLED.value in message


# #264-T06: a capability Coolify dropped so that the startup capabilities cannot be ended (SETPCAP)
# is the one case where the runner refuses to start: exit code 2, a log line that names the cause
# and no claim. Only that container stops; the Diff runner and the app are other containers.
def test_a_dynamic_runner_that_cannot_end_its_startup_capabilities_exits_without_serving(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    served: list[LoopSettings] = []

    def cannot_drop(settings: LoopSettings) -> bool:
        raise service.IsolationError("a capability could not be dropped from the bounding set")

    async def serve(settings: LoopSettings, environment: Any, **options: Any) -> int:
        served.append(settings)
        return 0

    monkeypatch.setattr(service, "prepare_dynamic_runtime", cannot_drop)
    monkeypatch.setattr(service, "serve", serve)

    assert service.run_from_environment(DYNAMIC_RUNNER) == 2

    assert served == []
    log = capsys.readouterr().err
    assert "cannot start" in log
    assert "bounding set" in log
