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


def test_the_identity_patch_and_the_installed_package_name_the_same_version() -> None:
    pinned = declared_requirement().removeprefix("pr-agent==")

    assert pinned == PATCHED_FOR_VERSION
    assert version("pr-agent") == pinned
