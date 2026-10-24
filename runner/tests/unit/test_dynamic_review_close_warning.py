# SPDX-License-Identifier: LicenseRef-Proprietary

"""A survivor of the engine's user that cannot be ended is logged, not only seen at the next job.

`EngineLaunch.close()` returns False when its sweep cannot finish and then leaves the network
rules in place (`test_dynamic_review_engine_user.py`). Both callers that end an engine
(`DynamicEngine.stop` and `shutdown_engines`) used to drop that result, so the only trace of a
process that could not be killed was the next job's refusal. Each now logs one warning.
"""

import logging
import os
from decimal import Decimal
from pathlib import Path

import pytest
from test_dynamic_review_deadline_order import dynamic_job

from code_reviewer_runner.dynamic_review import adapter, findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, shutdown_engines
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs

# 1 USD per million input tokens, 4 USD per million output tokens: a call has a price.
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


def launch(tmp_path: Path) -> EngineLaunch:
    config_dir = tmp_path / "job"
    config_dir.mkdir()
    return EngineLaunch(
        config_owner=os.getuid(),
        uid=os.getuid(),
        gid=os.getgid(),
        home=str(tmp_path / "home"),
        tmpdir=str(tmp_path / "tmp"),
        config_dir=config_dir,
    )


def engine_with(tmp_path: Path, mine: EngineLaunch) -> DynamicEngine:
    job = dynamic_job()
    return DynamicEngine(
        job,
        ledger=BudgetLedger(DynamicLimits(deadline_seconds=4.0), unit_costs=UNIT_COSTS),
        command=["unused"],
        directory=str(tmp_path / "export"),
        proxy_url="http://127.0.0.1:9",
        proxy_capability="capability",
        agent_prompt="prompt",
        model_schema=findings_schema(),
        inputs=ReviewInputs(pr_url=job.pr_url, pr_title="t", pr_body="b", diff=""),
        exported_paths=frozenset(),
        launch=mine,
        require_ripgrep=False,
    )


def survivor_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelno == logging.WARNING]


# #197-T07
def test_stopping_an_engine_whose_user_cannot_be_swept_logs_one_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(EngineLaunch, "sweep", lambda self: False)  # type: ignore[reportUnknownLambdaType]
    engine = engine_with(tmp_path, launch(tmp_path))

    with caplog.at_level(logging.WARNING):
        engine.stop()

    assert len(survivor_warnings(caplog)) == 1


# #197-T07
def test_stopping_an_engine_whose_user_is_swept_logs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    mine = launch(tmp_path)
    monkeypatch.setattr(EngineLaunch, "close", lambda self: True)  # type: ignore[reportUnknownLambdaType]
    engine = engine_with(tmp_path, mine)

    with caplog.at_level(logging.WARNING):
        engine.stop()

    assert survivor_warnings(caplog) == []


# #197-T07
def test_the_shutdown_of_an_engine_whose_user_cannot_be_swept_logs_one_warning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(EngineLaunch, "sweep", lambda self: False)  # type: ignore[reportUnknownLambdaType]
    monkeypatch.setattr(adapter, "_RUNNING_LAUNCHES", [launch(tmp_path)])

    with caplog.at_level(logging.WARNING):
        shutdown_engines()

    assert len(survivor_warnings(caplog)) == 1
