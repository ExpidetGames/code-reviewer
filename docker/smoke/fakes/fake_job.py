# SPDX-License-Identifier: LicenseRef-Proprietary

"""Test helper of docker/smoke/compose.sh, never part of a deployment: stands in for PR-Agent as the
job process of the runner (`PR_AGENT_COMMAND`). It reads the job from stdin like the real one, writes
a marker file so the smoke test can see that a job is running, and then does not finish: the test
stops the stack while this process is still busy.
"""

import sys
import time
from pathlib import Path

sys.stdin.read()
Path("/tmp/fake-job-started").write_text("started", encoding="utf-8")
time.sleep(600)
