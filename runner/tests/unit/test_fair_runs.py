"""Pins down handling of missing or null usage in fair_runs.py."""

import importlib.util
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).parents[3] / "docs" / "spike" / "data" / "cr-50" / "fair_runs.py"

spec = importlib.util.spec_from_file_location("fair_runs", SCRIPT)
assert spec is not None and spec.loader is not None
fair_runs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fair_runs)


def test_missing_usage_is_treated_as_unknown() -> None:
    usage = fair_runs.normalize_usage({})

    assert usage == {}
    assert usage.get("promptTokens") is None
    assert usage.get("completionTokens") is None


def test_null_usage_is_treated_as_unknown() -> None:
    usage = fair_runs.normalize_usage({"usage": None})

    assert usage == {}


def test_valid_usage_is_preserved() -> None:
    original: dict[str, Any] = {
        "costUsd": 0.12,
        "promptTokens": 100,
        "completionTokens": 50,
    }

    assert fair_runs.normalize_usage({"usage": original}) == original
