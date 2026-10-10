"""Pins down that the installed console script starts as a real process, which is what the
container and the compose stack run. Unit tests cover the logic; this proves the packaging."""

import subprocess
import sys
from pathlib import Path

from code_reviewer_runner import __version__


def _console_script() -> Path:
    return Path(sys.executable).parent / "code-reviewer-runner"


# CR-14-T02
def test_the_console_script_prints_the_version_and_exits_with_zero() -> None:
    result = subprocess.run(
        [str(_console_script()), "--version"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )

    assert result.returncode == 0
    assert result.stdout.strip() == f"code-reviewer-runner {__version__}"
    assert result.stderr == ""
