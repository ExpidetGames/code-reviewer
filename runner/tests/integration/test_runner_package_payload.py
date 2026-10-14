# SPDX-License-Identifier: Apache-2.0

"""#198-T07: the built runner distributions (wheel and sdist) ship the fixed core, the canonical
default skill and the three license notices, including their attribution. The build is offline: no
network call is made, and a build that tried one would fail loudly."""

import shutil
import subprocess
import tarfile
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
RUNNER = REPO_ROOT / "runner"

# The files the distributions must carry, as they appear inside the wheel.
DISTRIBUTION_FILES = {
    "code_reviewer_runner/dynamic_review/prompt_core.py",
    "code_reviewer_runner/dynamic_review/review-skill.md",
    "code_reviewer_runner/dynamic_review/findings-schema.v1.json",
    "code_reviewer_runner/licenses/LICENSE",
    "code_reviewer_runner/licenses/NOTICE",
    "code_reviewer_runner/licenses/THIRD_PARTY_LICENSES.md",
}


@pytest.fixture(scope="module")
def distributions(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """Build the wheel and the sdist once. Offline: the build backend is already cached."""
    directory = tmp_path_factory.mktemp("dist")
    uv = shutil.which("uv")
    assert uv, "uv is required to build the runner distributions"
    result = subprocess.run(
        [uv, "build", "--offline", "--out-dir", str(directory)],
        cwd=RUNNER,
        capture_output=True,
        text=True,
        timeout=240,
    )
    assert result.returncode == 0, result.stderr
    return next(directory.glob("*.whl")), next(directory.glob("*.tar.gz"))


def test_the_wheel_ships_the_core_the_skill_and_the_notices(
    distributions: tuple[Path, Path],
) -> None:
    wheel, _ = distributions

    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        missing = DISTRIBUTION_FILES - names
        assert not missing, missing
        notice = archive.read("code_reviewer_runner/licenses/NOTICE").decode("utf-8")
        third_party = archive.read("code_reviewer_runner/licenses/THIRD_PARTY_LICENSES.md").decode(
            "utf-8"
        )
        skill = archive.read("code_reviewer_runner/dynamic_review/review-skill.md").decode("utf-8")

    assert "OpenAI Codex" in notice
    assert "85e89cb7eeadb97fa9e4868d2b9977c87225506d" in third_party
    assert skill == (REPO_ROOT / "contracts" / "dynamic-review" / "review-skill.md").read_text()


def test_the_sdist_ships_the_core_the_skill_and_the_notices(
    distributions: tuple[Path, Path],
) -> None:
    _, sdist = distributions

    with tarfile.open(sdist) as archive:
        names = "\n".join(archive.getnames())

    for name in sorted(DISTRIBUTION_FILES):
        assert f"src/{name}" in names, name
