# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Worker advertises `opencode` only when the startup self-check passed (#202).

The check itself is pinned in `test_dynamic_review_self_check.py`; here the startup's use of it:
when it runs, what it changes in the settings, what it logs, and that a runner without an engine
user (every runner that is not the Dynamic runner) can never pass.
"""

import logging
from typing import Any

import pytest

from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_DIFF, ENGINE_DYNAMIC
from code_reviewer_runner.dynamic_review.netguard import EGRESS_MODE_VARIABLE, EgressMode
from code_reviewer_runner.dynamic_review.self_check import (
    DEFAULT_TOOLS,
    SelfCheckFailed,
    SelfCheckReason,
    SelfCheckResult,
)
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts
from code_reviewer_runner.job_loop.service import advertise_engines
from code_reviewer_runner.job_loop.settings import WorkerSettings, worker_settings_from_environment

PORTS = SlotPorts(10180, 10181)
BASE: dict[str, str] = {}
DYNAMIC_RUNNER = {**BASE, "RUNNER_DIFF_JOB_USER": "10001:10001"}


def dynamic_settings() -> WorkerSettings:
    return worker_settings_from_environment(DYNAMIC_RUNNER)


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
    assert seen == [
        {
            "user": (10101, 10101),
            "ports": PORTS,
            "rules_installed": True,
            "egress_mode": EgressMode.FULL,
        }
    ]
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
    settings = worker_settings_from_environment(BASE)

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


# #345-T10: the mode is logged with the advertisement and kept for the job processes.
@pytest.mark.parametrize("mode", list(EgressMode))
def test_the_advertisement_logs_the_egress_mode_and_keeps_it_for_the_job_processes(
    caplog: pytest.LogCaptureFixture, mode: EgressMode
) -> None:
    def passing(**facts: Any) -> SelfCheckResult:
        return SelfCheckResult(egress_mode=facts["egress_mode"])

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        settings = advertise_engines(dynamic_settings(), True, egress_mode=mode, check=passing)

    assert settings.engines == ALL_ENGINES
    assert settings.dynamic_egress_mode is mode
    assert f"egress rules: {mode.value}" in caplog.text


# #345-T10: a runner that is not advertised keeps the mode as well; no job reads it.
def test_a_failed_check_in_fallback_mode_is_not_advertised_and_names_the_ipv6_reason(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def ipv6_on(**facts: Any) -> None:
        raise SelfCheckFailed(SelfCheckReason.IPV6_NOT_DISABLED, "IPv6 is not proven off")

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        settings = advertise_engines(
            dynamic_settings(), True, egress_mode=EgressMode.FALLBACK, check=ipv6_on
        )

    assert settings.engines == (ENGINE_DIFF,)
    assert settings.dynamic_command is None
    assert "ipv6_not_disabled" in caplog.text


# #345-T11: the startup follows the kernel, and no variable of the container changes the mode: the
# settings are built before startup has run and do not read it.
def test_the_environment_does_not_choose_the_egress_mode() -> None:
    environment = {**DYNAMIC_RUNNER, EGRESS_MODE_VARIABLE: "fallback"}

    assert worker_settings_from_environment(environment).dynamic_egress_mode is EgressMode.FULL
