# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down how the Worker reads its configuration from the environment."""

import pytest

from code_reviewer_runner.capabilities import ENGINE_DIFF
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts
from code_reviewer_runner.job_loop.settings import SettingsError, worker_settings_from_environment

ROOT_WORKER = {"RUNNER_DIFF_JOB_USER": "10001:10001"}


def test_the_defaults_are_a_twenty_minute_timeout_and_the_job_entry_point() -> None:
    settings = worker_settings_from_environment({})

    assert settings.job_timeout == 1200.0
    assert settings.job_command[1:] == ("-m", "code_reviewer_runner.runner")


def test_the_job_timeout_can_be_configured() -> None:
    settings = worker_settings_from_environment({"RUNNER_JOB_TIMEOUT_SECONDS": "90"})

    assert settings.job_timeout == 90


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf", "99999999", "soon"])
def test_an_unusable_timeout_is_refused_naming_the_variable_and_never_the_value(
    value: str,
) -> None:
    with pytest.raises(SettingsError) as refusal:
        worker_settings_from_environment({"RUNNER_JOB_TIMEOUT_SECONDS": value})

    assert "RUNNER_JOB_TIMEOUT_SECONDS" in str(refusal.value)
    if len(value) > 4:
        assert value not in str(refusal.value)


def test_the_job_command_is_the_job_entry_point_unless_a_test_stack_replaces_it() -> None:
    replaced = worker_settings_from_environment(
        {"PR_AGENT_COMMAND": "python /fakes/fake_pr_agent.py --mode 'succeed fast'"}
    ).job_command

    assert replaced == ("python", "/fakes/fake_pr_agent.py", "--mode", "succeed fast")


def test_a_job_command_with_an_open_quote_is_refused() -> None:
    with pytest.raises(SettingsError, match="PR_AGENT_COMMAND"):
        worker_settings_from_environment({"PR_AGENT_COMMAND": "python 'unfinished"})


# #197-T04
def test_the_diff_job_user_is_unset_by_default_and_read_as_uid_and_gid() -> None:
    assert worker_settings_from_environment({}).diff_job_user is None
    settings = worker_settings_from_environment({"RUNNER_DIFF_JOB_USER": "10001:10002"})
    assert settings.diff_job_user == (10001, 10002)


# #197-T04
@pytest.mark.parametrize("value", ["10001", "root:root", "0:0", "10001:0", "0:10001", "-1:5", ":"])
def test_a_diff_job_user_that_is_root_or_not_numeric_is_refused(value: str) -> None:
    with pytest.raises(SettingsError, match="RUNNER_DIFF_JOB_USER"):
        worker_settings_from_environment({"RUNNER_DIFF_JOB_USER": value})


# #197-T04
def test_the_engine_user_of_a_root_worker_defaults_to_the_image_user_and_follows_variables() -> (
    None
):
    assert worker_settings_from_environment({}).dynamic_engine_user is None  # not a root Worker
    assert worker_settings_from_environment(ROOT_WORKER).dynamic_engine_user == (10101, 10101)
    custom = {
        **ROOT_WORKER,
        "RUNNER_DYNAMIC_ENGINE_UID": "20001",
        "RUNNER_DYNAMIC_ENGINE_GID": "20002",
    }
    assert worker_settings_from_environment(custom).dynamic_engine_user == (20001, 20002)


# #244-T04
def test_the_slot_ports_default_to_fixed_ones_and_follow_the_variables_on_a_root_worker() -> None:
    assert worker_settings_from_environment({}).dynamic_ports is None  # not a root Worker
    assert worker_settings_from_environment(ROOT_WORKER).dynamic_ports == SlotPorts(10180, 10181)
    custom = {
        **ROOT_WORKER,
        "RUNNER_DYNAMIC_PROXY_PORT": "20000",
        "RUNNER_DYNAMIC_ENGINE_PORT": "20001",
    }
    assert worker_settings_from_environment(custom).dynamic_ports == SlotPorts(20000, 20001)


# #244-T04
@pytest.mark.parametrize(
    "extra",
    [
        {"RUNNER_DYNAMIC_PROXY_PORT": "80"},  # privileged range
        {"RUNNER_DYNAMIC_ENGINE_PORT": "40000"},  # inside the ephemeral range
        {"RUNNER_DYNAMIC_PROXY_PORT": "proxy"},
        {"RUNNER_DYNAMIC_PROXY_PORT": "10181"},  # the same as the default engine port
    ],
)
def test_unusable_slot_ports_stop_the_worker_from_starting(extra: dict[str, str]) -> None:
    with pytest.raises(SettingsError, match="RUNNER_DYNAMIC_"):
        worker_settings_from_environment({**ROOT_WORKER, **extra})


# #197-T04
@pytest.mark.parametrize(
    "extra",
    [
        {"RUNNER_DYNAMIC_ENGINE_UID": "10001"},  # the Diff jobs' user
        {"RUNNER_DYNAMIC_ENGINE_GID": "10001"},  # the Diff jobs' group
        {"RUNNER_DYNAMIC_ENGINE_UID": "0"},
        {"RUNNER_DYNAMIC_ENGINE_GID": "engine"},
    ],
)
def test_an_engine_user_that_is_the_diff_job_user_or_root_is_refused(extra: dict[str, str]) -> None:
    with pytest.raises(SettingsError, match=r"RUNNER_DYNAMIC_ENGINE_[UG]ID"):
        worker_settings_from_environment({**ROOT_WORKER, **extra})


# #202-T03: settings alone never advertise opencode; only the startup self-check can add it.
def test_the_settings_alone_advertise_diff_only() -> None:
    assert worker_settings_from_environment({}).engines == (ENGINE_DIFF,)
    assert worker_settings_from_environment(ROOT_WORKER).engines == (ENGINE_DIFF,)
    assert worker_settings_from_environment(ROOT_WORKER).dynamic_command is None
