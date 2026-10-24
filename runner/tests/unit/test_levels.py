# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the per-level pytest timeouts that tests/conftest.py applies from a test's directory,
so a hung test fails fast at the unit level and still gets room at the slower levels."""

from typing import cast

import pytest


def test_a_unit_test_gets_a_ten_second_timeout(request: pytest.FixtureRequest) -> None:
    item = cast(pytest.Item, request.node)  # pyright: ignore[reportUnknownMemberType]
    marker = item.get_closest_marker("timeout")

    assert marker is not None
    assert marker.args == (10,)
