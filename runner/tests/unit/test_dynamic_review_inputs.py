# SPDX-License-Identifier: Apache-2.0

"""Pins down what the reviewer is given from the verified preparation (#197, wiring of #196)."""

import json
from pathlib import Path

from code_reviewer_runner.dynamic_review.checkout import (
    Omission,
    PreparedContent,
    Skipped,
    SkipReason,
)
from code_reviewer_runner.dynamic_review.content_policy import OmissionReason
from code_reviewer_runner.dynamic_review.inputs import (
    MAX_LIMITATION_LINES,
    review_inputs,
    split_metadata,
)
from code_reviewer_runner.dynamic_review.limits import CheckoutMetrics
from code_reviewer_runner.dynamic_review.prompts import compose_user_prompt

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"


def content(**overrides: object) -> PreparedContent:
    fields: dict[str, object] = {
        "root": Path("/job"),
        "export": Path("/job/checkout"),
        "head_sha": HEAD,
        "base_sha": "b" * 40,
        "merge_base_sha": "b" * 40,
        "previous_sha": None,
        "comparison": "full",
        "files": {"a.ts": "x\n"},
        "diff": "diff --git a/a.ts b/a.ts\n+x\n",
        "previous_diff": "",
        "omissions": (),
        "skipped": (),
        "metadata": json.dumps({"title": "Fix a", "body": "Because of b."}),
        "prior_state": "",
        "deadline": 0.0,
        "metrics": CheckoutMetrics(0, 0, 0, 1, {}, {}),
    }
    fields.update(overrides)
    return PreparedContent(**fields)  # type: ignore[arg-type]


# #197-T01
def test_the_model_is_given_the_real_title_body_and_diff() -> None:
    prompt = compose_user_prompt(review_inputs("https://github.com/o/r/pull/7", content()))

    assert "Fix a" in prompt
    assert "Because of b." in prompt
    assert "diff --git a/a.ts b/a.ts" in prompt
    assert "review mode: full" in prompt


# #197-T01
def test_metadata_the_preparer_did_not_structure_is_kept_as_the_body() -> None:
    assert split_metadata("just text") == ("", "just text")
    assert split_metadata('{"title": 1, "body": "x"}') == ("", '{"title": 1, "body": "x"}')
    assert split_metadata(json.dumps({"title": "t", "body": "b"})) == ("t", "b")


# #197-T13
def test_the_mode_is_the_one_the_preparation_ended_with_not_the_one_requested() -> None:
    # A requested incremental review whose previous tree was unavailable is a declared full review.
    full = review_inputs("u", content(comparison="full", previous_diff="old"))
    incremental = review_inputs(
        "u", content(comparison="incremental", previous_diff="diff --git since the last review\n")
    )

    assert full.comparison == "full" and full.incremental_diff == ""
    assert incremental.comparison == "incremental"
    assert "since the last review" in compose_user_prompt(incremental)


# #197-T01
def test_the_prior_state_reaches_the_prompt() -> None:
    prompt = compose_user_prompt(review_inputs("u", content(prior_state='{"findings": ["f-1"]}')))

    assert "previous-review-state" in prompt and "f-1" in prompt


# #197-T13
def test_what_the_preparation_could_not_give_the_reviewer_is_stated() -> None:
    inputs = review_inputs(
        "u",
        content(
            skipped=(Skipped("assets/logo.png", SkipReason.BINARY),),
            omissions=(Omission(".opencode/plugins/x.js", OmissionReason.ENGINE_DISCOVERY),),
        ),
    )

    assert "skipped (binary): assets/logo.png" in inputs.limitations
    assert "omitted (engine_discovery): .opencode/plugins/x.js" in inputs.limitations
    assert "review-limitations" in compose_user_prompt(inputs)
    assert review_inputs("u", content()).limitations == ""


# #197-T12
def test_the_list_of_limitations_is_bounded() -> None:
    many = tuple(Skipped(f"f{index}.bin", SkipReason.BINARY) for index in range(500))

    lines = review_inputs("u", content(skipped=many)).limitations.split("\n")

    assert len(lines) == MAX_LIMITATION_LINES + 1
    assert lines[-1] == "... and 300 more"
