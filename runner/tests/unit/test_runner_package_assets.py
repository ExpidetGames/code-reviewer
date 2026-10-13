# SPDX-License-Identifier: Apache-2.0

"""#198-T07: the runner package ships the canonical default skill and the license notices, byte for
byte. The canonical sources (`contracts/dynamic-review/review-skill.md` and the three repository
license files) stay the single source of truth; a divergent package copy fails here, before a build
even runs."""

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE = REPO_ROOT / "runner" / "src" / "code_reviewer_runner"

PACKAGED_ASSETS = [
    (
        PACKAGE / "dynamic_review" / "review-skill.md",
        REPO_ROOT / "contracts" / "dynamic-review" / "review-skill.md",
    ),
    (PACKAGE / "licenses" / "LICENSE", REPO_ROOT / "LICENSE"),
    (PACKAGE / "licenses" / "NOTICE", REPO_ROOT / "NOTICE"),
    (
        PACKAGE / "licenses" / "THIRD_PARTY_LICENSES.md",
        REPO_ROOT / "THIRD_PARTY_LICENSES.md",
    ),
]


@pytest.mark.parametrize(
    ("packaged", "canonical"), PACKAGED_ASSETS, ids=[p.name for p, _ in PACKAGED_ASSETS]
)
def test_a_packaged_asset_is_the_canonical_source(packaged: Path, canonical: Path) -> None:
    assert packaged.is_file(), packaged
    assert packaged.read_bytes() == canonical.read_bytes()
