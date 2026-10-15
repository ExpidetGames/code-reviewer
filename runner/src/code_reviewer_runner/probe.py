# SPDX-License-Identifier: Apache-2.0

"""The `probe` entry mode (#324): the startup self-check, one line of JSON, exit.

A launcher that must know whether a container is a Dynamic-capable Worker before it advertises
`opencode` (#331) runs the image with this mode in a canary and reads the verdict: the engines the
container may advertise and, when `opencode` is not among them, the stable reasons
(`SelfCheckReason` values). It involves no secret: it reads no token, no URL and no credential,
and prints no value of its environment.

The exit status says whether the probe ran, not whether the container passed: 0 with a verdict
(also when only `pr-agent` is advertised), 2 when the settings are unusable and there is nothing
to say. A container that cannot end its startup capabilities (a missing `SETPCAP`) is a verdict
too: `capabilities_not_dropped`.
"""

import logging
import sys
from collections.abc import Mapping
from typing import TextIO

from code_reviewer_runner.capabilities import ENGINE_DIFF
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.self_check import SelfCheckReason
from code_reviewer_runner.job_loop.service import LOGGER_NAME, configure_logging, run_startup
from code_reviewer_runner.job_loop.settings import SettingsError, worker_settings_from_environment
from code_reviewer_runner.verdict import Verdict


def run_probe(environment: Mapping[str, str], *, stdout: TextIO | None = None) -> int:
    """Run the startup, print the verdict on one line of `stdout`. Returns the exit code."""
    out = sys.stdout if stdout is None else stdout
    configure_logging()
    log = logging.getLogger(LOGGER_NAME)
    try:
        settings = worker_settings_from_environment(environment)
    except SettingsError as error:
        log.error("probe cannot start: %s", error)
        return 2
    try:
        _, verdict = run_startup(settings, require_read_only_root=True)
    except IsolationError as error:
        log.error("probe: the startup capabilities could not be dropped: %s", error)
        verdict = Verdict((ENGINE_DIFF,), (SelfCheckReason.CAPABILITIES_NOT_DROPPED.value,))
    out.write(verdict.to_json() + "\n")
    out.flush()
    return 0
