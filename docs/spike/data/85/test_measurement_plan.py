# SPDX-License-Identifier: Apache-2.0
"""Keep the offline experiment fair and keep routing/usage out of blinded records."""

import unittest
from collections import Counter

from measurement_plan import JsonRecord, blind, plan


class MeasurementPlan(unittest.TestCase):
    # #85: same CR-50 cases, first-review state and repeat count for both engines.
    def test_balanced_first_review_plan(self) -> None:
        p = plan()
        cells = Counter((t["engine"], t["fixture"]) for t in p["trials"])
        self.assertEqual(len(cells), 6)
        self.assertEqual(set(cells.values()), {4})
        self.assertTrue(
            all(t["state"] == "empty" and t["publication"] == "disabled" for t in p["trials"])
        )
        self.assertEqual(p["estimated_usd"]["at_0_30_in_1_20_out"], "0.6048")
        self.assertEqual(p["estimated_usd"]["ceiling_at_1_20_per_M_and_120k_each"], "3.456")

    # #85: scorer must not see model/engine/cost/hidden history attribution.
    def test_blind_record_excludes_private_metadata(self) -> None:
        capture: JsonRecord = {
            "capture_id": "trial-01",
            "findings": [],
            "summary": "No findings",
            "usage": {"model": "test"},
            "provenance": {"engine": "dynamic"},
        }
        self.assertEqual(
            blind(capture), {"capture_id": "trial-01", "findings": [], "summary": "No findings"}
        )
        with self.assertRaisesRegex(ValueError, "capture_shape"):
            blind({**capture, "state": "untrusted"})


if __name__ == "__main__":
    unittest.main()
