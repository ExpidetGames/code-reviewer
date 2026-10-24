# SPDX-License-Identifier: LicenseRef-Proprietary
"""Offline CR-50 follow-up plan and blinded captures; never calls a model or GitHub."""

import argparse
import json
import random
from decimal import Decimal
from pathlib import Path
from typing import Any

# Any represents externally supplied neutral JSON captures in this offline planning artifact.
JsonRecord = dict[str, Any]

MODEL = "deepseek/deepseek-v4.1-flash"


def plan(seed: int = 85) -> dict[str, Any]:
    trials: list[dict[str, Any]] = [
        {
            "engine": engine,
            "model": MODEL,
            "fixture": f"cr50-pr-{pr}",
            "round": repeat,
            "state": "empty",
            "publication": "disabled",
        }
        for repeat in range(1, 5)
        for pr in (1, 2, 3)
        for engine in ("diff", "dynamic")
    ]
    random.Random(seed).shuffle(trials)
    for index, trial in enumerate(trials, 1):
        trial["capture_id"] = f"trial-{index:02d}"
    return {
        "version": 1,
        "seed": seed,
        "trials": trials,
        "estimated_usd": {
            "assumption": "60000 input + 6000 output per trial; no cache credit",
            "at_0_14_in_0_42_out": str(
                Decimal(24)
                * (Decimal(60000) * Decimal("0.14") + Decimal(6000) * Decimal("0.42"))
                / Decimal(1000000)
            ),
            "at_0_30_in_1_20_out": str(
                Decimal(24)
                * (Decimal(60000) * Decimal("0.30") + Decimal(6000) * Decimal("1.20"))
                / Decimal(1000000)
            ),
            "ceiling_at_1_20_per_M_and_120k_each": str(
                Decimal(24) * Decimal(120000) * Decimal("1.20") / Decimal(1000000)
            ),
        },
        "requires": [
            "approved exact head snapshots for all three CR-50 fixtures",
            "patched/preflighted Dynamic adapter and OS guard",
            "workspace key provided in memory by trusted BYOK claim, never an env file",
            "both adapters emit captures without touching public comments",
            "same provider route on both engines or label the confound",
            "operator currency ceiling with pre-call reservation",
            "private scoring key; remove hidden state/timestamps before blind scoring",
        ],
    }


def blind(capture: dict[str, Any]) -> dict[str, Any]:
    # Accept only the neutral visible presentation. Usage/routing/state stay in private captures.
    if set(capture) != {"capture_id", "findings", "summary", "usage", "provenance"}:
        raise ValueError("capture_shape")
    return {k: capture[k] for k in ("capture_id", "findings", "summary")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "blind"])
    parser.add_argument("--capture", type=Path)
    args = parser.parse_args()
    if args.command == "plan":
        print(json.dumps(plan(), indent=2))
    else:
        if args.capture is None or args.capture.name.startswith(".env"):
            parser.error("a non-env capture JSON path is required")
        print(json.dumps(blind(json.loads(args.capture.read_text())), indent=2))
