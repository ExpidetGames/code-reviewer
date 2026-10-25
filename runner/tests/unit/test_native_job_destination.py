# SPDX-License-Identifier: LicenseRef-Proprietary

"""Where the key of a native job may be sent (#578, hardening after the security review).

The key of a registry provider (`anthropic`, `openrouter`) belongs to that provider's own API. The
legacy path always used the hard-coded `default_api_base` of the registry; the native path reads the
address from the claim's entry, so the runner pins it: an entry whose address is not the registry's
is a refused job, before any key is used and before any connection is made. A provider the runner
has no entry for is not judged by the registry: its destination rule is
`test_native_job_catalog_destination.py` (#555).
"""

import dataclasses
import json
from typing import Any

import pytest
from native_job_support import (
    CHAT_ENTRY,
    CHAT_MODEL,
    ENTRY,
    native_document,
    native_job,
)

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.native_job import build_native_job
from code_reviewer_runner.job import JobError, parse_job
from code_reviewer_runner.llm_providers import (
    ANTHROPIC,
    OPENROUTER,
    PROVIDERS,
    upstream_base_is_the_providers,
)
from code_reviewer_runner.result import ErrorCode

ATTACKER = "https://attacker.example/v1"


def refused(document: dict[str, Any]) -> JobError:
    with pytest.raises(JobError) as caught:
        parse_job(json.dumps(document))
    return caught.value


# #578-T27
def test_an_anthropic_job_with_another_address_is_refused_and_the_text_is_ours() -> None:
    error = refused(native_document(entry={**ENTRY, "upstreamBaseUrl": ATTACKER}))

    assert error.code is ErrorCode.INVALID_JOB
    assert error.detail == "dynamic.modelEntry.upstreamBaseUrl is not the address of the provider"
    assert "attacker" not in error.detail


# #578-T27
def test_an_openrouter_job_with_another_address_is_refused() -> None:
    document = native_document(
        entry={**CHAT_ENTRY, "upstreamBaseUrl": "https://openrouter.ai.attacker.example/api/v1"},
        model=CHAT_MODEL,
        provider="openrouter",
    )

    assert refused(document).code is ErrorCode.INVALID_JOB


# #578-T27
@pytest.mark.parametrize(
    "address",
    [
        "https://api.anthropic.com",
        "https://api.anthropic.com/v1/messages",
        "https://api.anthropic.com/v2",
        "https://API.anthropic.com/v1",
        "https://api.anthropic.com/v1?x=1",
        "https://openrouter.ai/api/v1",
    ],
)
def test_only_the_registry_address_is_accepted_for_anthropic(address: str) -> None:
    assert refused(native_document(entry={**ENTRY, "upstreamBaseUrl": address})).code in (
        ErrorCode.INVALID_JOB,
    )


# #578-T27
def test_the_registry_address_is_accepted_with_or_without_a_trailing_slash() -> None:
    for address in (ANTHROPIC.default_api_base, ANTHROPIC.default_api_base + "/"):
        job = native_job(entry={**ENTRY, "upstreamBaseUrl": address})
        assert job.dynamic is not None and job.dynamic.model_entry is not None

    chat = native_job(
        entry={**CHAT_ENTRY, "upstreamBaseUrl": OPENROUTER.default_api_base + "/"},
        model=CHAT_MODEL,
        provider="openrouter",
    )
    assert chat.dynamic is not None and chat.dynamic.model_entry is not None


# #578-T27
def test_the_builder_refuses_the_address_before_any_upstream_is_made() -> None:
    # Defence in depth: a job that did not come through `parse_job` (a test, a later caller) is
    # still not sent to an address of the claim's choosing.
    job = native_job()
    assert job.dynamic is not None and job.dynamic.model_entry is not None
    forged_entry = dataclasses.replace(job.dynamic.model_entry, upstream_base_url=ATTACKER)
    forged = dataclasses.replace(
        job, dynamic=dataclasses.replace(job.dynamic, model_entry=forged_entry)
    )
    made: list[str] = []

    def upstream_for(base_url: str) -> Any:
        made.append(base_url)
        raise AssertionError("no connection may be prepared for this address")

    with pytest.raises(LimitError) as caught:
        build_native_job(forged, deadline=600.0, environment={}, upstream_for=upstream_for)

    assert caught.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID
    assert caught.value.detail == "the model provider of the job cannot be used"
    assert made == []
    assert "attacker" not in caught.value.detail


# #578-T27
def test_the_registry_pin_does_not_judge_a_provider_the_registry_has_no_entry_for() -> None:
    assert "deepseek" not in PROVIDERS
    assert upstream_base_is_the_providers("deepseek", "https://api.deepseek.com") is True
    assert upstream_base_is_the_providers("deepseek", ATTACKER) is True


# #578-T27
def test_the_pin_compares_the_address_and_nothing_but_a_trailing_slash() -> None:
    assert upstream_base_is_the_providers("anthropic", "https://api.anthropic.com/v1")
    assert upstream_base_is_the_providers("anthropic", "https://api.anthropic.com/v1/")
    assert not upstream_base_is_the_providers("anthropic", "https://api.anthropic.com/v1//")
    assert not upstream_base_is_the_providers("anthropic", ATTACKER)
    assert not upstream_base_is_the_providers("openrouter", ANTHROPIC.default_api_base)
    assert upstream_base_is_the_providers("openrouter", OPENROUTER.default_api_base)


# #578-T32
def test_the_builder_refuses_an_entry_of_another_provider_than_the_key_is_for() -> None:
    # `parse_job` refuses such a job; the builder must not rely on it. The entry here is the
    # registry provider's (`anthropic`) and the key is for `deepseek`: the key of a provider never
    # follows the address of another provider's entry (the rule of a catalog provider's own entry
    # is `test_native_job_catalog_destination.py`, #555).
    job = native_job()
    assert job.dynamic is not None and job.dynamic.model_entry is not None
    entry = dataclasses.replace(
        job.dynamic.model_entry, upstream_base_url="https://api.deepseek.com"
    )
    forged = dataclasses.replace(
        job,
        llm=dataclasses.replace(job.llm, provider="deepseek"),
        dynamic=dataclasses.replace(job.dynamic, model_entry=entry),
    )
    made: list[str] = []

    def upstream_for(base_url: str) -> Any:
        made.append(base_url)
        raise AssertionError("no connection may be prepared for this provider")

    with pytest.raises(LimitError) as caught:
        build_native_job(forged, deadline=600.0, environment={}, upstream_for=upstream_for)

    assert caught.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID
    assert caught.value.detail == "the model provider of the job cannot be used"
    assert made == []
