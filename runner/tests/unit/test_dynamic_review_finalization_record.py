# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the native finalization remembers for the log line (#578): the class of the problem with
the message that ended the turn, whether the one repair was asked for, and what it returned."""

from pathlib import Path

from test_dynamic_review_plain_adapter import (
    HOSTILE,
    Client,
    engine_with,
    reply,
    review_text,
    run_turns,
)

from code_reviewer_runner.dynamic_review.final_json import Problem


# #578-T17
def test_a_review_the_model_ended_the_turn_with_is_ok_and_not_repaired(tmp_path: Path) -> None:
    engine = engine_with(tmp_path, plain=True)

    run_turns(engine, Client([reply(review_text())]))

    record = engine.finalization
    assert record is not None
    assert (record.first, record.repaired, record.second) == ("ok", False, "none")
    assert record.final_call == "normal"


# #578-T17
def test_a_repaired_review_remembers_the_problem_and_the_repair(tmp_path: Path) -> None:
    engine = engine_with(tmp_path, plain=True)

    run_turns(engine, Client([reply(f"{HOSTILE}, no JSON"), reply(review_text())]))

    record = engine.finalization
    assert record is not None
    assert (record.first, record.repaired, record.second) == (
        Problem.NO_JSON_OBJECT.value,
        True,
        "ok",
    )


# #578-T17
def test_a_repair_that_fails_too_remembers_both_problems(tmp_path: Path) -> None:
    engine = engine_with(tmp_path, plain=True)

    run_turns(engine, Client([reply(f"{HOSTILE}, no JSON"), reply(f"{HOSTILE}, again")]))

    record = engine.finalization
    assert record is not None
    assert (record.first, record.repaired, record.second) == (
        Problem.NO_JSON_OBJECT.value,
        True,
        Problem.NO_JSON_OBJECT.value,
    )


# #578-T17
def test_the_legacy_path_has_no_finalization_record(tmp_path: Path) -> None:
    assert engine_with(tmp_path, plain=False).finalization is None
