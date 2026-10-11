"""Tests of the pure part of fair_runs.py: what is read from the result of a run.

Some providers return no usage block, so a result may carry `"usage": null` or no `usage` key at all.
That means "unknown", not a crash and not zero. Run them with the interpreter of the `runner/`
virtual environment (fair_runs.py imports manual_review, which needs it), from the repository root:

    uv --directory runner run python -m unittest discover -s ../docs/spike/data/cr-50 -v
"""

import argparse
import contextlib
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

import fair_runs


class UsageFiguresTest(unittest.TestCase):
    def test_a_usage_block_gives_its_figures(self) -> None:
        result: dict[str, Any] = {
            "ok": True,
            "usage": {"promptTokens": 1200, "completionTokens": 300, "costUsd": 0.0123},
        }

        self.assertEqual(
            fair_runs.usage_figures(result),
            {"promptTokens": 1200, "completionTokens": 300, "costUsd": 0.0123},
        )

    def test_usage_null_means_unknown(self) -> None:
        result: dict[str, Any] = {"ok": True, "usage": None}

        self.assertEqual(
            fair_runs.usage_figures(result),
            {"promptTokens": None, "completionTokens": None, "costUsd": None},
        )

    def test_a_missing_usage_key_means_unknown(self) -> None:
        self.assertEqual(
            fair_runs.usage_figures({"ok": False, "errorCode": "llm_error"}),
            {"promptTokens": None, "completionTokens": None, "costUsd": None},
        )

    def test_a_usage_block_with_a_missing_or_null_figure_marks_only_that_figure_unknown(
        self,
    ) -> None:
        result: dict[str, Any] = {
            "usage": {"promptTokens": 50, "completionTokens": None}
        }

        self.assertEqual(
            fair_runs.usage_figures(result),
            {"promptTokens": 50, "completionTokens": None, "costUsd": None},
        )

    def test_a_real_cost_of_zero_stays_zero(self) -> None:
        figures = fair_runs.usage_figures({"usage": {"costUsd": 0}})

        self.assertEqual(figures["costUsd"], 0.0)

    def test_unknown_figures_are_written_as_unknown_in_the_summary_line(self) -> None:
        self.assertEqual(fair_runs.show_figure(None), "unknown")
        self.assertEqual(fair_runs.show_figure(1200), "1200")
        self.assertEqual(fair_runs.show_figure(0.5, "{:.4f}"), "0.5000")


class RunWithoutUsageTest(unittest.TestCase):
    """A whole run (GitHub and the review itself replaced by stand-ins) whose result has no usage."""

    def run_with_result(
        self, result: dict[str, Any]
    ) -> tuple[list[str], list[str], int]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = argparse.Namespace(
                model="deepseek/deepseek-v3.2",
                pr=1,
                round=1,
                suffix="",
                out=str(root / "out"),
                blind=str(root / "blind"),
                mapping=str(root / "mapping.csv"),
            )

            def fake_review(command: list[str], **_: Any) -> Any:
                records = Path(command[command.index("--record-dir") + 1])
                label = command[command.index("--label") + 1]
                (records / f"{label}.json").write_text(json.dumps({"result": result}))
                return mock.Mock(stdout="", stderr="", returncode=0)

            output = io.StringIO()
            with (
                mock.patch.object(fair_runs, "mint_token", return_value="token"),
                mock.patch.object(fair_runs.mr, "check_label"),
                mock.patch.object(
                    fair_runs,
                    "delete_bot_comments",
                    return_value={"botCommentsDeleted": []},
                ),
                mock.patch.object(fair_runs.subprocess, "run", side_effect=fake_review),
                contextlib.redirect_stdout(output),
            ):
                code = fair_runs.run_one(args)
            with Path(args.mapping).open(newline="") as handle:
                header, row = list(csv.reader(handle))
            return header, row, code

    def test_a_result_with_usage_null_is_recorded_with_unknown_figures(self) -> None:
        header, row, code = self.run_with_result(
            {"ok": False, "errorCode": "x", "usage": None}
        )

        self.assertEqual(code, 0)
        cells = dict(zip(header, row, strict=True))
        self.assertEqual(
            (cells["costUsd"], cells["promptTokens"], cells["completionTokens"]),
            ("", "", ""),
        )

    def test_a_result_without_a_usage_key_is_recorded_with_unknown_figures(
        self,
    ) -> None:
        header, row, code = self.run_with_result({"ok": False, "errorCode": "x"})

        self.assertEqual(code, 0)
        cells = dict(zip(header, row, strict=True))
        self.assertEqual(
            (cells["costUsd"], cells["promptTokens"], cells["completionTokens"]),
            ("", "", ""),
        )


if __name__ == "__main__":
    unittest.main()
