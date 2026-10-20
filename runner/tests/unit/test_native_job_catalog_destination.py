# SPDX-License-Identifier: Apache-2.0

"""Where the own key of a provider outside the registry may be sent (#555, needs a security review).

The key of a provider of the models.dev catalog (`deepseek`, `groq`, ...) goes to the address the
app's catalog trusts for it (#548: https, a public host, trusted on first use, a change blocks it
until an admin confirms). The claim carries that address in the entry; the runner has no list of
its own for such a provider, so it judges what it can: the entry must be of the provider the key is
for, the address must be a plain public https address in the exact spelling the app judged (no
other spelling of the same address is accepted), and the connection checks every address it
resolves to and never follows a redirect (`upstream.py`). A job that fails any of it is refused
before a key is used or a connection is made. The registry providers keep their pinned address
(`test_native_job_destination.py`).
"""

import dataclasses
import json
import re
import sys
from pathlib import Path
from typing import Any, cast

import pytest
from native_job_support import (
    API_KEY,
    DEEPSEEK_ENTRY,
    DEEPSEEK_MODEL,
    OWN_COST,
    native_document,
    native_job,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from passthrough_support import ScriptedUpstream, streamed
from test_native_dynamic_job_run import RecordingEngine, run
from test_native_job import FakeEngine

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.native_job import build_native_job
from code_reviewer_runner.dynamic_review.passthrough.address import UpstreamRefused
from code_reviewer_runner.dynamic_review.passthrough.destination import key_destination
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpsUpstream,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
)
from code_reviewer_runner.job import JobError, parse_job
from code_reviewer_runner.result import ErrorCode

ADDRESS_REFUSED = "dynamic.modelEntry.upstreamBaseUrl is not the address of the provider"


def catalog_document(
    *, entry: dict[str, Any] | None = None, provider: str = "deepseek"
) -> dict[str, Any]:
    return native_document(
        entry=DEEPSEEK_ENTRY if entry is None else entry,
        cost=OWN_COST,
        model=DEEPSEEK_MODEL,
        provider=provider,
    )


def catalog_job(**options: Any) -> Any:
    return parse_job(json.dumps(catalog_document(**options)))


def refused(document: dict[str, Any]) -> JobError:
    with pytest.raises(JobError) as caught:
        parse_job(json.dumps(document))
    return caught.value


# #555-T12
def test_a_native_job_of_a_catalog_provider_is_read_with_its_entry_address() -> None:
    job = catalog_job()

    assert job.llm.provider == "deepseek"
    assert job.llm.api_key == API_KEY
    assert job.llm.base_url is None
    assert job.llm.require_parameters is False
    assert job.llm.fallback_models == ()
    assert job.dynamic is not None and job.dynamic.model_entry is not None
    assert job.dynamic.model_entry.upstream_base_url == "https://api.deepseek.com"


# #555-T12
def test_a_slug_with_an_underscore_is_the_provider_id_with_a_hyphen() -> None:
    entry = {**DEEPSEEK_ENTRY, "providerId": "fireworks-ai"}

    job = catalog_job(entry=entry, provider="fireworks_ai")

    assert job.llm.provider == "fireworks_ai"
    assert (
        refused(catalog_document(entry=entry, provider="fireworks")).code is ErrorCode.INVALID_JOB
    )


# #555-T12
@pytest.mark.parametrize(
    "address",
    [
        # Another scheme, a port, credentials, a query: nothing but a plain https address.
        "http://api.deepseek.com",
        "https://api.deepseek.com:8443",
        "https://api.deepseek.com:443",
        "https://deepseek-key@api.deepseek.com",
        "https://api.deepseek.com?x=1",
        # A destination that is not public: loopback, private, link-local (cloud metadata), IPv6.
        "https://127.0.0.1",
        "https://localhost/v1",
        "https://10.0.0.5/v1",
        "https://169.254.169.254/latest",
        "https://[::1]/v1",
        "https://[fe80::1]/v1",
        "https://models.internal/v1",
        "https://2130706433/v1",
        # Other spellings of an address: the runner connects to exactly what the app judged.
        "https://API.deepseek.com",
        "https://api.deepseek.com./v1",
        "https://api.deepseek.com//v1",
        "https://api.deepseek.com/v1/../v2",
        "https://api.deepseek.com/v1%2f..%2fv2",
        "https://api.deepseek.com/v1/",
        "https://api.deepseek.com/ v1",
    ],
)
def test_an_address_that_is_not_the_plain_public_https_address_is_refused(address: str) -> None:
    error = refused(catalog_document(entry={**DEEPSEEK_ENTRY, "upstreamBaseUrl": address}))

    assert error.code is ErrorCode.INVALID_JOB
    # The shape of the entry refuses some of them before the destination is judged; both are ours.
    assert error.detail in (ADDRESS_REFUSED, "dynamic.modelEntry is not a job model entry")
    assert address not in error.detail


# #555-T12
def test_an_entry_of_another_provider_than_the_one_the_key_is_for_is_refused() -> None:
    # The key of `deepseek` must not follow an entry whose address belongs to another provider.
    other = {
        **DEEPSEEK_ENTRY,
        "providerId": "groq",
        "upstreamBaseUrl": "https://api.groq.com/openai/v1",
    }

    error = refused(catalog_document(entry=other))

    assert error.code is ErrorCode.INVALID_JOB
    assert "api.groq.com" not in error.detail


# #555-T12
@pytest.mark.parametrize("provider", ["Deepseek", "d", "deep-seek", "deepseek!", "x" * 33, ""])
def test_a_provider_that_is_no_slug_is_refused(provider: str) -> None:
    entry = {**DEEPSEEK_ENTRY, "providerId": provider.replace("_", "-") or "x"}

    assert refused(catalog_document(entry=entry, provider=provider)).code is ErrorCode.INVALID_JOB


# #555-T12
def test_a_catalog_provider_needs_the_native_path() -> None:
    # No entry (or a Diff job): the legacy path knows the registry only, so the job is refused.
    document = catalog_document()
    del document["dynamic"]["modelEntry"]
    del document["dynamic"]["cost"]
    assert refused(document).code is ErrorCode.INVALID_JOB

    diff = catalog_document()
    for key in ("reviewKind", "dynamic", "base"):
        del diff[key]
    assert refused(diff).code is ErrorCode.INVALID_JOB


# #555-T12
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("baseUrl", "http://127.0.0.1:9"),
        ("fallbackModels", ["other-model"]),
        ("requireParameters", True),
    ],
)
def test_a_catalog_provider_takes_no_address_or_fallback_from_the_llm_section(
    field: str, value: Any
) -> None:
    document = catalog_document()
    document["llm"][field] = value

    assert refused(document).code is ErrorCode.INVALID_JOB


# #555-T12
def test_the_builder_connects_to_exactly_the_address_of_the_entry() -> None:
    job = catalog_job()
    made: list[str] = []

    def upstream_for(base_url: str) -> Any:
        made.append(base_url)
        return cast(Any, object())

    build_native_job(job, deadline=600.0, environment={}, upstream_for=upstream_for)

    assert made == ["https://api.deepseek.com"]


# #555-T12
@pytest.mark.parametrize(
    "address",
    [
        "http://api.deepseek.com",
        "https://127.0.0.1/v1",
        "https://169.254.169.254/latest",
        "https://API.deepseek.com",
        "https://api.deepseek.com:8443",
        "https://api.deepseek.com/v1/",
    ],
)
def test_the_builder_refuses_a_forged_address_before_any_upstream_is_made(address: str) -> None:
    # Defence in depth: a job that did not come through `parse_job` is still not sent to an address
    # the runner can judge wrong. (What it cannot judge is a well-formed public name that is not the
    # provider's: only the app's trust record says that, and the app never builds an entry from an
    # address that is not the trusted one, `native-cost/service.integration.test.ts`.)
    job = catalog_job()
    assert job.dynamic is not None and job.dynamic.model_entry is not None
    forged_entry = dataclasses.replace(job.dynamic.model_entry, upstream_base_url=address)
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


# #555-T12
def test_the_builder_refuses_an_entry_that_is_not_of_the_provider_of_the_key() -> None:
    job = catalog_job()
    assert job.dynamic is not None and job.dynamic.model_entry is not None
    other = dataclasses.replace(job.dynamic.model_entry, provider_id="groq")
    forged = dataclasses.replace(job, dynamic=dataclasses.replace(job.dynamic, model_entry=other))

    with pytest.raises(LimitError) as caught:
        build_native_job(
            forged, deadline=600.0, environment={}, upstream_for=lambda _url: cast(Any, object())
        )

    assert caught.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID


def test_the_support_job_is_a_native_job() -> None:
    # Guards the fixtures of this file: the registry job is still read as before.
    assert native_job().llm.provider == "anthropic"


# #555-T12
def test_the_connection_to_a_catalog_provider_judges_the_address_it_resolves_to_every_time() -> (
    None
):
    # The name was public when the catalog stored it; a name can change what it resolves to. The
    # upstream of the builder checks every address on every connection, so a name that resolves to a
    # private address later gets no key (the generic cases are `test_passthrough_destination.py`).
    job = catalog_job()
    made: list[HttpsUpstream] = []
    connected: list[tuple[str, int]] = []

    def connect(address: tuple[str, int], _timeout: float) -> Any:
        connected.append(address)
        raise AssertionError("no connection may be made to a private address")

    def upstream_for(base_url: str) -> HttpsUpstream:
        made.append(HttpsUpstream(base_url, resolve=lambda _host: ["10.0.0.5"], connect=connect))
        return made[-1]

    build_native_job(job, deadline=600.0, environment={}, upstream_for=upstream_for)

    with pytest.raises(UpstreamError) as caught:
        made[0].send(UpstreamRequest(path="/chat/completions", headers={}, body=b"{}"), 5.0)
    assert caught.value.kind is UpstreamFailure.ADDRESS_REFUSED
    assert caught.value.sent is False
    assert connected == []


# #555-T12
def test_a_whole_job_of_a_catalog_provider_runs_through_the_passthrough(tmp_path: Path) -> None:
    seen: list[str] = []
    upstream = ScriptedUpstream(streamed(WireFamily.OPENAI_CHAT))

    result, publisher = run(
        tmp_path,
        catalog_job(),
        upstream=upstream,
        engine_factory=RecordingEngine,
        seen=seen,
    )

    assert result.ok, result.log_tail
    assert len(publisher.calls) == 1
    assert seen == ["https://api.deepseek.com"]
    assert FakeEngine.made[0].options["provider_id"] == "deepseek"
    assert API_KEY not in result.log_tail


VECTORS = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts" / "key-destination-vectors.json").read_text(
        encoding="utf-8"
    )
)


def destination_accepts(address: str) -> bool:
    base = parse_job(json.dumps(catalog_document())).dynamic
    assert base is not None and base.model_entry is not None
    try:
        key_destination(
            "deepseek", dataclasses.replace(base.model_entry, upstream_base_url=address)
        )
    except UpstreamRefused:
        return False
    return True


# #555-T12
@pytest.mark.parametrize("address", VECTORS["accepted"])
def test_the_vectors_both_sides_accept_are_accepted(address: str) -> None:
    assert destination_accepts(address) is True


# #555-T12
@pytest.mark.parametrize("address", VECTORS["refused"])
def test_the_vectors_both_sides_refuse_are_refused(address: str) -> None:
    assert destination_accepts(address) is False


# #555-T14
def test_an_ip_literal_of_any_kind_is_refused_and_the_vectors_keep_it_on_the_refused_side() -> None:
    literal = re.compile(r"^https://(\[|[0-9.x]+(/|$))", re.IGNORECASE)
    assert [a for a in VECTORS["accepted"] if literal.match(a)] == []
    for address in (
        "https://93.184.216.34/v1",
        "https://1572395042/v1",
        "https://0x5db8d822/v1",
        "https://[2606:4700:4700:0:0:0:0:1111]/v1",
        "https://[2606:4700:4700::1111%25eth0]/v1",
        "https://[::ffff:93.184.216.34]/v1",
        "https://[2002:5db8:d822::1]/v1",
        "https://[64:ff9b::5db8:d822]/v1",
    ):
        assert address in VECTORS["refused"]
        assert destination_accepts(address) is False
