# SPDX-License-Identifier: Apache-2.0

"""The control command of the manual review script (CR-11-T05) as a real process."""

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

SCRIPT = Path(__file__).parents[2] / "scripts" / "manual_review.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("manual_review_control", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["manual_review_control"] = module
    spec.loader.exec_module(module)
    return module


def test_the_control_command_still_refuses_an_invalid_job_like_the_real_entry_point() -> None:
    command = load_script().runner_command(identity_patch=False)

    process = subprocess.run(
        command, input="not json", capture_output=True, text=True, timeout=50, check=False
    )

    assert process.returncode == 1
    assert '"errorCode":"invalid_job"' in process.stdout
