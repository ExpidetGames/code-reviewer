# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the command line surface of the runner entry point without starting a process."""

import pytest

from code_reviewer_runner import __version__
from code_reviewer_runner.cli import main


# CR-14-T02
def test_version_flag_prints_the_package_version_and_exits_cleanly(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(["--version"])

    assert exit_code == 0
    assert capsys.readouterr().out.strip() == f"code-reviewer-runner {__version__}"


def test_an_unknown_option_is_rejected_with_a_usage_error(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main(["--no-such-option"])

    assert exit_code == 2
    assert "usage:" in capsys.readouterr().err


# CR-29: without a configuration the loop does not start and says which variable is missing.
def test_the_loop_does_not_start_without_the_url_of_the_app(
    capsys: pytest.CaptureFixture[str],
) -> None:
    exit_code = main([], environment={"RUNNER_TOKEN": "dummy-runner-token-0123456789-abcdef"})

    assert exit_code == 2
    error = capsys.readouterr().err
    assert "RUNNER_API_URL is required" in error
    assert "dummy-runner-token" not in error


def test_the_loop_does_not_start_with_an_unusable_value_and_never_prints_the_token(
    capsys: pytest.CaptureFixture[str],
) -> None:
    token = "dummy-runner-token-0123456789-abcdef"
    exit_code = main(
        [],
        environment={
            "RUNNER_API_URL": "http://app:3000",
            "RUNNER_TOKEN": token,
            "RUNNER_CONCURRENCY": "lots",
        },
    )

    assert exit_code == 2
    error = capsys.readouterr().err
    assert "RUNNER_CONCURRENCY must be a number" in error
    assert token not in error
