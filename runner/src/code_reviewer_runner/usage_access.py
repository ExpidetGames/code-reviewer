# SPDX-License-Identifier: LicenseRef-Proprietary

"""Reads a field of a model call's usage, whether it came as a mapping (a provider's JSON, the
Dynamic proxy's translated answer) or as an object (LiteLLM's `Usage`)."""

from collections.abc import Mapping
from typing import Any


def usage_field(source: object, name: str) -> Any:
    """The field of a usage, or None when it has none."""
    if isinstance(source, Mapping):
        return source.get(name)  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    return getattr(source, name, None)
