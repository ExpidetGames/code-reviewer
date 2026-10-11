# SPDX-License-Identifier: Apache-2.0

"""Pins down that PR-Agent is installed from exactly one version everywhere it is declared: the
dependency in pyproject.toml, the locked version in uv.lock, the version the identity patch was
written for and the version that is installed. A mismatch means a PR-Agent upgrade happened without
re-checking the patch."""

import re
import tomllib
from importlib.metadata import version
from pathlib import Path

from code_reviewer_runner.identity_patch import PATCHED_FOR_VERSION

RUNNER_ROOT = Path(__file__).parents[2]


def declared_requirement() -> str:
    project = tomllib.loads((RUNNER_ROOT / "pyproject.toml").read_text())["project"]
    requirements = [dep for dep in project["dependencies"] if dep.startswith("pr-agent")]
    assert len(requirements) == 1
    return requirements[0]


def locked_version() -> str:
    lock = tomllib.loads((RUNNER_ROOT / "uv.lock").read_text())
    packages = [package for package in lock["package"] if package["name"] == "pr-agent"]
    assert len(packages) == 1
    return packages[0]["version"]


# CR-10-T10
def test_pr_agent_is_pinned_with_an_exact_version_in_pyproject() -> None:
    assert re.fullmatch(r"pr-agent==\d+\.\d+\.\d+", declared_requirement())


# CR-10-T10
def test_the_locked_version_equals_the_pinned_version() -> None:
    pinned = declared_requirement().removeprefix("pr-agent==")

    assert locked_version() == pinned


def version_advice(pinned: str, installed: str) -> str:
    return (
        f"pr-agent is pinned to {pinned} and installed as {installed}, but the identity patch was "
        f"checked for {PATCHED_FOR_VERSION}. Check the identity patch against the new release "
        "(tests/unit/test_identity_funnel.py explains how), then raise PATCHED_FOR_VERSION in "
        "identity_patch.py to the pinned version."
    )


# CR-30-T05
def test_the_identity_patch_and_the_installed_package_name_the_same_version() -> None:
    pinned = declared_requirement().removeprefix("pr-agent==")
    installed = version("pr-agent")

    assert pinned == PATCHED_FOR_VERSION, version_advice(pinned, installed)
    assert installed == pinned, version_advice(pinned, installed)


# CR-45: the protection against evaluated settings values (`@format`, `@jinja`) was written and
# proven against this Dynaconf version. A different version comes with a PR-Agent upgrade; the tests
# in test_settings_evaluation.py and test_repo_settings_guard.py must be read again before this
# constant is changed.
VERIFIED_DYNACONF_VERSION = "3.3.5"


def test_the_installed_dynaconf_is_the_version_the_evaluation_protection_was_proven_with() -> None:
    lock = tomllib.loads((RUNNER_ROOT / "uv.lock").read_text())
    locked = [package["version"] for package in lock["package"] if package["name"] == "dynaconf"]

    assert locked == [VERIFIED_DYNACONF_VERSION]
    assert version("dynaconf") == VERIFIED_DYNACONF_VERSION
