# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down that the package can report a version even when it is run from source without being
installed, instead of failing on import."""

from importlib.metadata import PackageNotFoundError

import pytest

import code_reviewer_runner


def test_an_uninstalled_package_falls_back_to_a_placeholder_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def not_installed(_name: str) -> str:
        raise PackageNotFoundError

    monkeypatch.setattr(code_reviewer_runner, "version", not_installed)

    assert code_reviewer_runner.resolve_version() == "0+unknown"
