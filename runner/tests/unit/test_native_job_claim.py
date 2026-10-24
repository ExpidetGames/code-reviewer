# SPDX-License-Identifier: LicenseRef-Proprietary

"""The claim of a native Dynamic job on the runner's side (#578): the per-job model entry travels
in `dynamic.modelEntry` next to the cost policy of #553, and the runner reads both as strictly as
the app writes them. A job without an entry is a job of today."""

import json
from typing import Any

import pytest
from native_job_support import ENTRY, MANAGED_COST, MODEL, native_document, native_job

from code_reviewer_runner.job import JobError, parse_job
from code_reviewer_runner.result import ErrorCode


def refused(document: dict[str, Any]) -> JobError:
    with pytest.raises(JobError) as caught:
        parse_job(json.dumps(document))
    return caught.value


# #578-T09
def test_a_native_job_carries_its_entry_and_cost_policy() -> None:
    job = native_job()

    assert job.dynamic is not None
    assert job.dynamic.model_entry is not None
    assert job.dynamic.model_entry.provider_id == "anthropic"
    assert job.dynamic.model_entry.model_id == MODEL
    assert job.dynamic.cost is not None


# #578-T09
def test_a_job_without_an_entry_is_a_job_of_today() -> None:
    document = native_document()
    del document["dynamic"]["modelEntry"]
    del document["dynamic"]["cost"]

    job = parse_job(json.dumps(document))

    assert job.dynamic is not None
    assert job.dynamic.model_entry is None
    assert job.dynamic.cost is None


# #578-T09
def test_an_entry_without_a_cost_policy_is_refused() -> None:
    document = native_document()
    del document["dynamic"]["cost"]

    error = refused(document)

    assert error.code is ErrorCode.INVALID_JOB
    assert "dynamic.modelEntry" in error.detail


# #578-T09
def test_an_entry_for_another_model_than_the_job_names_is_refused() -> None:
    document = native_document()
    document["dynamic"]["modelEntry"] = {**ENTRY, "modelId": "claude-opus-5-5"}

    assert refused(document).code is ErrorCode.INVALID_JOB


# #578-T09
def test_an_entry_of_another_provider_than_the_key_is_refused() -> None:
    # The key is the registry provider's. An entry of another provider would send it there.
    document = native_document(provider="openrouter")

    assert refused(document).code is ErrorCode.INVALID_JOB


# #578-T09
@pytest.mark.parametrize(
    "entry",
    [
        {**ENTRY, "apiKey": "sk-live"},
        {**ENTRY, "npm": "left-pad"},
        {**ENTRY, "upstreamBaseUrl": "http://api.anthropic.com"},
        {**ENTRY, "model": {**ENTRY["model"], "tool_call": False}},
        "anthropic",
        None,
        [],
    ],
)
def test_a_broken_entry_is_refused(entry: Any) -> None:
    document = native_document()
    document["dynamic"]["modelEntry"] = entry

    assert refused(document).code is ErrorCode.INVALID_JOB


# #578-T09
def test_the_detail_of_a_refused_entry_names_the_field_and_no_value() -> None:
    document = native_document()
    document["dynamic"]["modelEntry"] = {**ENTRY, "upstreamBaseUrl": "http://secret.example"}

    detail = refused(document).detail

    assert "dynamic.modelEntry" in detail
    assert "secret.example" not in detail
    assert MANAGED_COST["keyMode"] not in detail
