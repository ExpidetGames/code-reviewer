# SPDX-License-Identifier: Apache-2.0

"""Pins down how the job loop reads its configuration from the environment."""

import pytest

from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts
from code_reviewer_runner.job_loop.settings import SettingsError, settings_from_environment

TOKEN = "dummy-runner-token-0123456789-abcdef-0123456789"
BASE = {"RUNNER_API_URL": "http://app:3000/", "RUNNER_TOKEN": TOKEN}


def test_the_defaults_are_three_slots_a_five_second_poll_and_a_twenty_minute_timeout() -> None:
    settings = settings_from_environment(BASE)

    assert settings.api_url == "http://app:3000"
    assert settings.concurrency == 3
    assert settings.poll_interval == 5.0
    assert settings.job_timeout == 1200.0
    assert settings.shutdown_grace == 60.0
    assert settings.runner_id.startswith("runner-")


def test_every_value_can_be_configured() -> None:
    settings = settings_from_environment(
        {
            **BASE,
            "RUNNER_ID": "runner-a:1",
            "RUNNER_CONCURRENCY": "2",
            "RUNNER_POLL_INTERVAL_SECONDS": "0.5",
            "RUNNER_JOB_TIMEOUT_SECONDS": "90",
            "RUNNER_SHUTDOWN_GRACE_SECONDS": "5",
        }
    )

    assert (settings.runner_id, settings.concurrency) == ("runner-a:1", 2)
    assert (settings.poll_interval, settings.job_timeout, settings.shutdown_grace) == (0.5, 90, 5)


@pytest.mark.parametrize(
    ("override", "variable"),
    [
        ({"RUNNER_API_URL": ""}, "RUNNER_API_URL"),
        ({"RUNNER_API_URL": "ftp://app"}, "RUNNER_API_URL"),
        ({"RUNNER_API_URL": "http://user:pw@app:3000"}, "RUNNER_API_URL"),
        ({"RUNNER_API_URL": "http://app:3000/?x=1"}, "RUNNER_API_URL"),
        ({"RUNNER_TOKEN": ""}, "RUNNER_TOKEN"),
        ({"RUNNER_TOKEN": "two words"}, "RUNNER_TOKEN"),
        ({"RUNNER_ID": "bad id"}, "RUNNER_ID"),
        ({"RUNNER_CONCURRENCY": "0"}, "RUNNER_CONCURRENCY"),
        ({"RUNNER_CONCURRENCY": "99"}, "RUNNER_CONCURRENCY"),
        ({"RUNNER_CONCURRENCY": "1.5"}, "RUNNER_CONCURRENCY"),
        ({"RUNNER_CONCURRENCY": "many"}, "RUNNER_CONCURRENCY"),
        ({"RUNNER_POLL_INTERVAL_SECONDS": "0"}, "RUNNER_POLL_INTERVAL_SECONDS"),
        ({"RUNNER_JOB_TIMEOUT_SECONDS": "-1"}, "RUNNER_JOB_TIMEOUT_SECONDS"),
        ({"RUNNER_JOB_TIMEOUT_SECONDS": "nan"}, "RUNNER_JOB_TIMEOUT_SECONDS"),
        ({"RUNNER_SHUTDOWN_GRACE_SECONDS": "inf"}, "RUNNER_SHUTDOWN_GRACE_SECONDS"),
    ],
)
def test_an_unusable_value_is_refused_naming_the_variable_and_never_the_value(
    override: dict[str, str], variable: str
) -> None:
    with pytest.raises(SettingsError) as refusal:
        settings_from_environment({**BASE, **override})

    assert variable in str(refusal.value)
    for value in override.values():
        if len(value) > 4:
            assert value not in str(refusal.value)


def test_the_token_does_not_show_up_in_the_text_form_of_the_settings() -> None:
    assert TOKEN not in repr(settings_from_environment(BASE))


def test_the_job_command_is_the_job_entry_point_unless_a_test_stack_replaces_it() -> None:
    default = settings_from_environment(BASE).job_command
    replaced = settings_from_environment(
        {**BASE, "PR_AGENT_COMMAND": "python /fakes/fake_pr_agent.py --mode 'succeed fast'"}
    ).job_command

    assert default[1:] == ("-m", "code_reviewer_runner.runner")
    assert replaced == ("python", "/fakes/fake_pr_agent.py", "--mode", "succeed fast")


def test_a_job_command_with_an_open_quote_is_refused() -> None:
    with pytest.raises(SettingsError, match="PR_AGENT_COMMAND"):
        settings_from_environment({**BASE, "PR_AGENT_COMMAND": "python 'unfinished"})


# #197-T04
def test_the_diff_job_user_is_unset_by_default_and_read_as_uid_and_gid() -> None:
    assert settings_from_environment(BASE).diff_job_user is None
    settings = settings_from_environment({**BASE, "RUNNER_DIFF_JOB_USER": "10001:10002"})
    assert settings.diff_job_user == (10001, 10002)


# #197-T04
@pytest.mark.parametrize("value", ["10001", "root:root", "0:0", "10001:0", "0:10001", "-1:5", ":"])
def test_a_diff_job_user_that_is_root_or_not_numeric_is_refused(value: str) -> None:
    with pytest.raises(SettingsError, match="RUNNER_DIFF_JOB_USER"):
        settings_from_environment({**BASE, "RUNNER_DIFF_JOB_USER": value})


# #197-T04
def test_the_engine_user_of_a_root_loop_defaults_to_the_image_user_and_follows_the_variables() -> (
    None
):
    assert settings_from_environment(BASE).dynamic_engine_user is None  # not the Dynamic runner
    root = {**BASE, "RUNNER_DIFF_JOB_USER": "10001:10001"}
    assert settings_from_environment(root).dynamic_engine_user == (10101, 10101)
    custom = {**root, "RUNNER_DYNAMIC_ENGINE_UID": "20001", "RUNNER_DYNAMIC_ENGINE_GID": "20002"}
    assert settings_from_environment(custom).dynamic_engine_user == (20001, 20002)


# #244-T04
def test_the_slot_ports_default_to_fixed_ones_and_follow_the_variables_on_a_root_loop() -> None:
    assert settings_from_environment(BASE).dynamic_ports is None  # not the Dynamic runner
    root = {**BASE, "RUNNER_DIFF_JOB_USER": "10001:10001"}
    assert settings_from_environment(root).dynamic_ports == SlotPorts(10180, 10181)
    custom = {**root, "RUNNER_DYNAMIC_PROXY_PORT": "20000", "RUNNER_DYNAMIC_ENGINE_PORT": "20001"}
    assert settings_from_environment(custom).dynamic_ports == SlotPorts(20000, 20001)


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
def test_unusable_slot_ports_stop_the_runner_from_starting(extra: dict[str, str]) -> None:
    with pytest.raises(SettingsError, match="RUNNER_DYNAMIC_"):
        settings_from_environment({**BASE, "RUNNER_DIFF_JOB_USER": "10001:10001", **extra})


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
        settings_from_environment({**BASE, "RUNNER_DIFF_JOB_USER": "10001:10001", **extra})
