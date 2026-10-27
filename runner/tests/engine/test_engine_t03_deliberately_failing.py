# SPDX-License-Identifier: LicenseRef-Proprietary

"""Throwaway (#713-T03): proves a failing engine test fails the rollup check. Never merged."""

import pytest

pytestmark = pytest.mark.engine


def test_this_engine_test_fails_on_purpose() -> None:
    raise AssertionError("#713-T03: deliberate failure")
