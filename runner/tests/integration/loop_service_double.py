# SPDX-License-Identifier: LicenseRef-Proprietary

"""Test helper, not a test: runs the real service of the job loop (signals, logging, event loop)
with the job command of a test.

    python loop_service_double.py '<json list: the job command>'

Everything else comes from the environment, exactly as for `code-reviewer-runner`.
"""

import asyncio
import dataclasses
import json
import os
import sys

from code_reviewer_runner.job_loop.service import configure_logging, serve
from code_reviewer_runner.job_loop.settings import settings_from_environment

configure_logging()
environment = dict(os.environ)
settings = dataclasses.replace(
    settings_from_environment(environment),
    job_command=tuple(json.loads(sys.argv[1])),
    terminate_grace=1.0,
    kill_margin=0.5,
)
sys.exit(asyncio.run(serve(settings, environment)))
