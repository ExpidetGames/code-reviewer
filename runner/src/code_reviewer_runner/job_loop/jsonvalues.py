# SPDX-License-Identifier: LicenseRef-Proprietary

"""Typed access to JSON values that come from outside (the app's answers, a process's output)."""

from typing import Any, cast


def as_object(value: object) -> dict[str, Any] | None:
    """The value as a JSON object, or None if it is anything else."""
    return cast(dict[str, Any], value) if isinstance(value, dict) else None
