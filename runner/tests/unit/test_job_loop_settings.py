"""Pins down how the job loop reads its configuration from the environment."""

import pytest

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
