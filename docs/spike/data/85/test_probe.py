# SPDX-License-Identifier: LicenseRef-Proprietary
"""Real-engine experiments; run only in the documented network-none spike container."""

import unittest
from typing import ClassVar

from probe import ProbeReport, run_probe


class EngineProbe(unittest.TestCase):
    report: ClassVar[ProbeReport]

    @classmethod
    def setUpClass(cls) -> None:
        cls.report = run_probe()

    # #85: explicit reads stay available with discovery switches.
    def test_explicit_reads_and_directory_listing_work(self) -> None:
        self.assertTrue(self.report["explicit_rule_read"])
        self.assertTrue(self.report["directory_read"])
        self.assertEqual(self.report["offered_tools"], ["StructuredOutput", "glob", "grep", "read"])

    # #85: capture the unsafe stock behavior instead of claiming a safe invocation.
    def test_nested_rule_is_automatically_injected_in_stock_release(self) -> None:
        self.assertTrue(self.report["nested_rule_injected"])
        self.assertFalse(self.report["root_rule_injected"])
        self.assertFalse(self.report["plugin_executed"])

    # #85: an adversarial fake model attempts capabilities forbidden by the core.
    def test_permission_boundary_holds_under_injection(self) -> None:
        self.assertTrue(self.report["all_forbidden_calls_failed"])
        self.assertTrue(self.report["checkout_unchanged"])
        self.assertTrue(self.report["external_read_denied"])
        self.assertTrue(self.report["structured_output"])
        self.assertEqual(self.report["engine_version"], "1.19.0")
        self.assertEqual(len(self.report["forbidden_attempts"]), 6)
        self.assertGreater(self.report["main_calls"], self.report["steps_configured"])

    # #85: parent proc and host paths are outside the bwrap mount namespace.
    def test_non_root_sandbox(self) -> None:
        self.assertEqual(self.report["uid"], 10001)
        self.assertTrue(self.report["sandbox_write_denied"])
        self.assertTrue(self.report["sandbox_host_path_absent"])
        self.assertTrue(self.report["sandbox_parent_pid_absent"])
        self.assertTrue(self.report["engine_reaped"])


if __name__ == "__main__":
    unittest.main()
