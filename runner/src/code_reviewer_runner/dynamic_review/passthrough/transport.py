# SPDX-License-Identifier: Apache-2.0

"""Which way a job reaches its model (#550): the passthrough proxy, or the legacy wire.

A job whose claim carries a per-job model entry (`contracts/job-model-entry.v1.json`, #548) is a
native job and goes through the passthrough proxy. A job without one is a job of today (OpenRouter,
Anthropic through their wires in `proxy.py`) and nothing about it changes. Both run side by side
until #556 removes the wires.
"""

from enum import StrEnum


class Transport(StrEnum):
    PASSTHROUGH = "passthrough"
    LEGACY_WIRE = "legacy-wire"


def transport_of(entry: object | None) -> Transport:
    """The transport of a job from its model entry, if the claim has one."""
    return Transport.LEGACY_WIRE if entry is None else Transport.PASSTHROUGH
