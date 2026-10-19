# SPDX-License-Identifier: Apache-2.0

"""What the generic fakes of `fakes/wire` state as usage, in the runner's counts (#550). Not a test
file; the unit, integration and engine tests of the passthrough proxy share it."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fakes.wire.formats import usage_for

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.usage import CallUsage


def usage_expected(call: int, family: WireFamily) -> CallUsage:
    """What the fakes state for `call`, as the runner counts it: the prompt includes the cache."""
    u = usage_for(call)
    if family is WireFamily.ANTHROPIC_MESSAGES:
        writes = u.cache_write_5m + u.cache_write_1h
        return CallUsage(u.input + u.cache_read + writes, u.output, u.cache_read, writes, None)
    if family is WireFamily.GOOGLE:
        return CallUsage(u.input, u.output + u.reasoning, u.cache_read, 0, None)
    return CallUsage(u.input, u.output, u.cache_read, 0, None)
