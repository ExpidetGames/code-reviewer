# SPDX-License-Identifier: LicenseRef-Proprietary

"""The script that feeds the license check of the repository (app/src/ci/license-check): it prints
the license metadata of the installed packages as JSON, and fails loudly instead of printing
nothing."""

import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parents[2] / "scripts" / "list_licenses.py"


# #118-T02
def test_it_lists_every_installed_package_with_its_license_metadata() -> None:
    process = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True,
        text=True,
        timeout=50,
        check=False,
    )

    assert process.returncode == 0, process.stderr
    records = json.loads(process.stdout)
    by_name = {record["name"].lower(): record for record in records}
    assert {"name", "version", "expression", "license", "classifiers"} <= set(records[0])
    # The runner itself is proprietary (#677): it declares no SPDX expression, only the license text
    # "Proprietary". The license check leaves our own package out (collect.ts, withoutFirstParty).
    assert by_name["code-reviewer-runner"]["expression"] is None
    assert by_name["code-reviewer-runner"]["license"] == "Proprietary"
    # pytest is installed for the tests, so the dev group is part of the listing.
    assert "pytest" in by_name
    assert [record["name"].lower() for record in records] == sorted(by_name)
