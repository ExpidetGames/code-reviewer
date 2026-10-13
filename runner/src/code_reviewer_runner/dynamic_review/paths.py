# SPDX-License-Identifier: Apache-2.0
"""Portable tracked paths; no host path interpretation or symlink traversal."""

import re

from .limits import CheckoutError, Limits

_WINDOWS_RESERVED = re.compile(r"(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?")


def validate_path(path: str, limits: Limits) -> tuple[str, ...]:
    parts = tuple(path.split("/"))
    if (
        len(path.encode("utf-8")) > limits.path_bytes
        or len(parts) > limits.path_depth
        or any(ord(char) < 32 or ord(char) == 127 for char in path)
        or "\\" in path
        or ":" in path
        or any(
            part in ("", ".", "..")
            or part.lower() == ".git"
            or part.endswith((".", " "))
            or _WINDOWS_RESERVED.fullmatch(part)
            for part in parts
        )
    ):
        raise CheckoutError()
    return parts
