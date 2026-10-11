# SPDX-License-Identifier: Apache-2.0

"""Prints the license metadata of every package installed in this environment as JSON.

The license check of the repository (app/src/ci/license-check) reads the output:

    uv run python scripts/list_licenses.py

It only reads the metadata that uv installed (the `METADATA` file of each distribution), so it needs
no network. For each package it prints the name, the version, the `License-Expression` field, the
start of the `License` field (some packages put their whole license text there) and the trove
classifiers that name a license. The judgement is made on the other side, which also knows the
allow list; this script only collects.
"""

import json
import sys
from importlib.metadata import distributions

# A License field that holds a whole license text only needs its first lines to be recognized.
LICENSE_FIELD_LIMIT = 500


def main() -> int:
    records: list[dict[str, object]] = []
    for distribution in distributions():
        metadata = distribution.metadata
        name = metadata["Name"]
        if not name:
            continue
        classifiers = [
            classifier
            for classifier in metadata.get_all("Classifier") or []
            if str(classifier).startswith("License ::")
        ]
        expression = metadata.get("License-Expression")
        license_field = metadata.get("License")
        records.append(
            {
                "name": name,
                "version": distribution.version,
                "expression": expression or None,
                "license": license_field[:LICENSE_FIELD_LIMIT] if license_field else None,
                "classifiers": classifiers,
            }
        )
    records.sort(key=lambda record: (str(record["name"]).lower(), str(record["version"])))
    json.dump(records, sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
