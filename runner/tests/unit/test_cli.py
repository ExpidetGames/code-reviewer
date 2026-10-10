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
