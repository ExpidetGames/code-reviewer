# SPDX-License-Identifier: Apache-2.0

"""Dynamic Review prompt assets and composition (#198).

`prompt_core.py` owns the fixed, code-owned core (read-only rules, untrusted-data rules, output
format, re-review rules); `prompts.py` composes it with the editable, lower-priority review skill
from a claim and demarcates the untrusted pull request input. `dynamic_findings.py` validates the
model's answer against the contract. The engine that calls the model is `adapter.py` (#197): it
drives the pinned stock engine through the trusted config (`config.py`), the runner-owned model
proxy (`proxy.py`) and the shared ledger (`limits.py`).

`findings_schema()` reads the packaged copy of `contracts/dynamic-review/schema.v1.json`: the
engine's `format` mode needs the schema at run time and the runner image ships its own copy, kept
byte-identical to the contract by a unit test (the same pattern as `review-skill.md`).
"""

import json
from pathlib import Path
from typing import Any

SCHEMA_FILE = Path(__file__).with_name("findings-schema.v1.json")


def findings_schema() -> dict[str, Any]:
    """The JSON schema of one Dynamic Review answer, as the engine's structured-output format."""
    value: Any = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    return value  # pyright: ignore[reportUnknownVariableType]
