# SPDX-License-Identifier: Apache-2.0

"""The engine's ripgrep is the one the startup self-check verified, never a PATH lookup (#202).

The self-check judges `/usr/local/bin/rg` by its pin. If the engine found `rg` by searching its
PATH, another `rg` earlier on that PATH (the optional Node directory, for one) would run instead of
the verified file. The adapter therefore puts the verified file's directory first on the engine's
PATH and refuses to start without it.
"""

import shutil
import stat
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from test_dynamic_review_deadline_order import dynamic_job

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, EngineError
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs
from code_reviewer_runner.result import ErrorCode

# 1 USD per million input tokens, 4 USD per million output tokens: a call has a price.
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


def executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def engine_with(
    tmp_path: Path, *, ripgrep: Path | None, node_bin: str | None, seen: list[dict[str, str]]
) -> DynamicEngine:
    def popen(argv: list[str], **kwargs: Any) -> Any:
        seen.append(kwargs["env"])
        raise OSError("no process in this test")

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
        scratch_dir=str(tmp_path / "scratch"),
        node_bin=node_bin,
        ripgrep=ripgrep,
        popen=popen,  # type: ignore[arg-type]
    )


# #202-T04
def test_a_different_rg_earlier_in_the_path_is_never_the_engines_ripgrep(tmp_path: Path) -> None:
    verified = executable(tmp_path / "verified" / "rg")
    rogue = executable(tmp_path / "node" / "rg")
    seen: list[dict[str, str]] = []
    engine = engine_with(tmp_path, ripgrep=verified, node_bin=str(rogue.parent), seen=seen)

    with pytest.raises(EngineError):  # the fake popen fails; only its environment matters
        engine.start()

    assert len(seen) == 1
    assert shutil.which("rg", path=seen[0]["PATH"]) == str(verified)


# #202-T04
def test_an_engine_without_a_verified_ripgrep_file_is_not_started(tmp_path: Path) -> None:
    seen: list[dict[str, str]] = []
    # A usable rg exists on the PATH; it is not the verified one, so it must not be enough.
    rogue = executable(tmp_path / "node" / "rg")
    engine = engine_with(
        tmp_path, ripgrep=tmp_path / "missing" / "rg", node_bin=str(rogue.parent), seen=seen
    )

    with pytest.raises(EngineError) as raised:
        engine.start()

    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert seen == []


# #202-T04
def test_an_engine_given_no_ripgrep_at_all_is_not_started(tmp_path: Path) -> None:
    seen: list[dict[str, str]] = []
    rogue = executable(tmp_path / "node" / "rg")
    engine = engine_with(tmp_path, ripgrep=None, node_bin=str(rogue.parent), seen=seen)

    with pytest.raises(EngineError) as raised:
        engine.start()

    assert raised.value.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert seen == []
