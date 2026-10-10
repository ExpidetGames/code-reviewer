"""Shared pytest setup.

The level of a test is decided by its directory (tests/unit, tests/integration, tests/contract,
tests/engine), so the marker can never drift from where the file lives. A test outside those
directories is a collection error: it would otherwise run unmarked and escape every level.
"""

from pathlib import Path

import pytest

_LEVELS = ("unit", "integration", "contract", "engine")
_TESTS_ROOT = Path(__file__).parent


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        relative = Path(item.path).relative_to(_TESTS_ROOT)
        level = relative.parts[0]
        if level not in _LEVELS:
            raise pytest.UsageError(
                f"{relative} is not under tests/{{{','.join(_LEVELS)}}}; "
                "place the test in the directory of its level"
            )
        item.add_marker(getattr(pytest.mark, level))
