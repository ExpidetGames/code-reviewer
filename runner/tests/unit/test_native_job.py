# SPDX-License-Identifier: Apache-2.0

"""The native path of one Dynamic job, joined (#578): the entry and the policy of the claim become
a ledger, a passthrough proxy and the configuration of an engine that is given only the chosen
model and the job's capability. The engine is a double that asks the proxy what the real one would
ask; the provider is the strict double of the passthrough tests. Nothing leaves the loopback."""

import http.client
import json
import sys
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, ClassVar
from urllib.parse import urlsplit

import pytest
from native_job_support import API_KEY, ENTRY, MANAGED_COST, MODEL, OWN_COST, native_job

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from passthrough_support import REAL_KEY, ScriptedUpstream, streamed

from code_reviewer_runner.dynamic_findings import DynamicFindings, parse_dynamic_findings
from code_reviewer_runner.dynamic_review.adapter import EngineAnswer
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.limits import CheckoutMetrics
from code_reviewer_runner.dynamic_review.native_job import (
    NativeJob,
    NativeStartError,
    build_native_job,
    run_native_engine,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.job import Job
from code_reviewer_runner.llm_providers import ANTHROPIC, PROVIDERS
from code_reviewer_runner.result import ErrorCode

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
FAMILY = WireFamily.ANTHROPIC_MESSAGES


def findings() -> DynamicFindings:
    return parse_dynamic_findings(
        {
            "resolvedIds": [],
            "findings": [
                {
                    "id": "f-1",
                    "priority": "P2",
                    "confidence": 0.7,
                    "title": "Unvalidated value",
                    "body": "The value is passed on.",
                    "path": "src/app.py",
                    "lineStart": 1,
                    "lineEnd": 2,
                    "evidence": ["src/app.py:1"],
                }
            ],
        },
        exported_paths=frozenset({"src/app.py"}),
        reviewed_sha=HEAD,
    )


def content_at(export: Path) -> PreparedContent:
    return PreparedContent(
        root=export.parent,
        export=export,
        head_sha=HEAD,
        base_sha="b" * 40,
        merge_base_sha="b" * 40,
        previous_sha=None,
        comparison="full",
        files={"src/app.py": "x\n"},
        diff="diff --git a/src/app.py b/src/app.py\n+x\n",
        previous_diff="",
        omissions=(),
        skipped=(),
        metadata=json.dumps({"title": "Add a handler", "body": "Please review."}),
        prior_state="",
        deadline=0.0,
        metrics=CheckoutMetrics(0, 0, 0, 1, {}, {}),
    )


class FakeEngine:
    """Stands where `DynamicEngine` stands: records how it was made and, on `run`, makes the one
    request the real engine would, with the only credential it was given."""

    made: ClassVar[list["FakeEngine"]] = []

    def __init__(self, job: Job, **options: Any) -> None:
        self.job = job
        self.options = options
        self.turn_seconds: list[float] = []
        self.recovery: str | None = None
        self.finalization = None
        self.status: int | None = None
        FakeEngine.made.append(self)

    def run(self) -> EngineAnswer:
        spec = spec_of(FAMILY)
        host, port = proxy_address(self.options["proxy_url"])
        body = json.dumps(
            {
                "model": MODEL,
                "stream": True,
                "max_tokens": 1000,
                "messages": [{"role": "user", "content": "review this"}],
            }
        ).encode()
        connection = http.client.HTTPConnection(host, port, timeout=10)
        connection.request(
            "POST",
            spec.engine_target(MODEL),
            body=body,
            headers={
                spec.key_header: spec.key_value(self.options["proxy_capability"]),
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
            },
        )
        response = connection.getresponse()
        response.read()
        self.status = response.status
        connection.close()
        return EngineAnswer(findings=findings(), error=None)


@pytest.fixture(autouse=True)
def _forget_engines() -> None:
    FakeEngine.made.clear()


def proxy_address(url: object) -> tuple[str, int]:
    parts = urlsplit(str(url))
    assert parts.hostname is not None and parts.port is not None
    return parts.hostname, parts.port


def upstream_for(upstream: ScriptedUpstream, seen: list[str] | None = None) -> Any:
    def make(base_url: str) -> ScriptedUpstream:
        if seen is not None:
            seen.append(base_url)
        return upstream

    return make


@contextmanager
def started(
    tmp_path: Path, job: Job | None = None, upstream: ScriptedUpstream | None = None, **options: Any
) -> Generator[tuple[NativeJob, Job, ScriptedUpstream]]:
    job = job or native_job()
    upstream = upstream or ScriptedUpstream(streamed(FAMILY))
    native = build_native_job(
        job,
        deadline=600.0,
        environment=options.pop("environment", {}),
        upstream_for=upstream_for(upstream),
        **options,
    )
    yield native, job, upstream


def run(native: NativeJob, job: Job, tmp_path: Path, **options: Any) -> Any:
    export = tmp_path / "export"
    export.mkdir(exist_ok=True)
    return run_native_engine(
        native,
        job,
        command=["unused"],
        content=content_at(export),
        launch=None,
        node_bin=None,
        ripgrep=None,
        superseded=lambda: False,
        engine_factory=FakeEngine,  # type: ignore[arg-type]
        **options,
    )


# #578-T11
def test_the_proxy_is_built_from_the_entry_and_the_address_is_the_entrys(tmp_path: Path) -> None:
    seen: list[str] = []
    job = native_job()

    native = build_native_job(
        job,
        deadline=600.0,
        environment={},
        upstream_for=upstream_for(ScriptedUpstream(streamed(FAMILY)), seen),
    )

    assert seen == ["https://api.anthropic.com/v1"]
    assert native.entry.model_id == MODEL
    assert native.capability != API_KEY
    assert len(native.capability) >= 43


# #578-T11
def test_the_operators_cost_limit_is_read_from_the_variable_the_legacy_path_reads() -> None:
    from code_reviewer_runner import runner
    from code_reviewer_runner.dynamic_review import native_job

    assert native_job._MAX_COST_VARIABLE == runner.DYNAMIC_MAX_COST_VARIABLE  # pyright: ignore[reportPrivateUsage]


# #578-T14
def test_the_cost_limit_of_the_operator_is_the_limit_of_the_ledger(tmp_path: Path) -> None:
    from decimal import Decimal

    job = native_job()

    native = build_native_job(
        job,
        deadline=600.0,
        environment={"RUNNER_DYNAMIC_MAX_COST_USD": "0.25"},
        upstream_for=upstream_for(ScriptedUpstream(streamed(FAMILY))),
    )

    assert native.ledger.limits.max_cost_usd == Decimal("0.25")


# #578-T14
def test_a_cost_limit_that_is_no_number_ends_the_job_before_the_engine() -> None:
    job = native_job()

    with pytest.raises(LimitError) as caught:
        build_native_job(
            job,
            deadline=600.0,
            environment={"RUNNER_DYNAMIC_MAX_COST_USD": "a lot"},
            upstream_for=upstream_for(ScriptedUpstream(streamed(FAMILY))),
        )

    assert caught.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID


# #578-T14
def test_the_managed_policy_ends_a_run_on_an_unknown_cost_and_the_own_one_does_not(
    tmp_path: Path,
) -> None:
    with started(tmp_path, native_job(cost=MANAGED_COST)) as (managed, _job, _upstream):
        assert managed.run.proxy.ends_run_on_unknown_cost is True
        assert managed.ledger.priced is True
    with started(tmp_path, native_job(cost=OWN_COST)) as (own, _job, _upstream):
        assert own.run.proxy.ends_run_on_unknown_cost is False
        assert own.ledger.priced is False


# #578-T13
@pytest.mark.parametrize(
    "address",
    [
        "https://127.0.0.1",
        "https://10.0.0.5",
        "https://169.254.169.254",
        "https://localhost",
        "https://api.anthropic.com:8443",
    ],
)
def test_an_upstream_address_the_guard_refuses_ends_the_job_before_the_engine(
    address: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The registry pins the address of its providers (T27); to reach the guard of the address
    # itself, the registry here names the refused address, as a later provider's entry could.
    monkeypatch.setitem(PROVIDERS, "anthropic", replace(ANTHROPIC, default_api_base=address))
    job = native_job(entry={**ENTRY, "upstreamBaseUrl": address})

    with pytest.raises(LimitError) as caught:
        build_native_job(job, deadline=600.0, environment={})

    assert caught.value.code is ErrorCode.DYNAMIC_CONFIG_INVALID
    assert address not in caught.value.detail


# #578-T11
def test_the_engine_is_given_only_the_chosen_model_and_the_capability(tmp_path: Path) -> None:
    with started(tmp_path) as (native, job, _upstream):
        outcome = run(native, job, tmp_path)

    engine = FakeEngine.made[0]
    config = engine.options["engine_config"]
    assert outcome.answer.error is None
    assert engine.options["plain_final"] is True
    assert engine.options["provider_id"] == "anthropic"
    assert config["enabled_providers"] == ["anthropic"]
    block = config["provider"]["anthropic"]
    assert list(block["models"]) == [MODEL]
    assert block["options"]["apiKey"] == native.capability
    assert block["options"]["baseURL"].startswith("http://127.0.0.1:")
    assert config["agent"]["review"]["model"] == f"anthropic/{MODEL}"


# #578-T12
def test_the_real_key_and_the_upstream_address_never_reach_the_engine(tmp_path: Path) -> None:
    with started(tmp_path) as (native, job, _upstream):
        run(native, job, tmp_path)

    engine = FakeEngine.made[0]
    handed = {name: value for name, value in engine.options.items() if name != "provider_error"}
    for forbidden in (API_KEY, "api.anthropic.com"):
        assert forbidden not in json.dumps(handed, default=str)
    assert engine.options["proxy_capability"] == native.capability


# #578-T11
def test_a_request_of_the_engine_is_relayed_with_the_real_key_and_booked(tmp_path: Path) -> None:
    with started(tmp_path, upstream=ScriptedUpstream(streamed(FAMILY))) as (
        native,
        job,
        upstream,
    ):
        run(native, job, tmp_path)

    assert FakeEngine.made[0].status == 200
    ((request,),) = [upstream.requests]
    spec = spec_of(FAMILY)
    sent = {name.lower(): value for name, value in request.headers.items()}
    assert sent[spec.key_header.lower()] == spec.key_value(API_KEY)
    assert native.capability not in json.dumps(sent)
    assert native.ledger.model_calls == 1
    assert REAL_KEY not in json.dumps(sent)


# #578-T11
def test_the_server_is_stopped_when_the_run_ends(tmp_path: Path) -> None:
    with started(tmp_path) as (native, job, _upstream):
        run(native, job, tmp_path)

    host, port = proxy_address(FakeEngine.made[0].options["proxy_url"])
    with pytest.raises(OSError):
        http.client.HTTPConnection(host, port, timeout=2).request("GET", "/")


# #578-T11
def test_a_slot_port_somebody_holds_is_a_slot_that_is_not_clean(tmp_path: Path) -> None:
    import socket

    from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch

    held = socket.socket()
    held.bind(("127.0.0.1", 0))
    held.listen(1)
    port = held.getsockname()[1]
    launch = EngineLaunch(
        uid=10101,
        gid=10101,
        home=str(tmp_path / "home"),
        tmpdir=str(tmp_path / "tmp"),
        config_dir=tmp_path,
        proxy_port=port,
        engine_port=port + 1,
        egress_mode="fallback",  # type: ignore[arg-type]
    )
    try:
        with started(tmp_path) as (native, job, _upstream):
            export = tmp_path / "export"
            export.mkdir()
            with pytest.raises(NativeStartError) as caught:
                run_native_engine(
                    native,
                    job,
                    command=["unused"],
                    content=content_at(export),
                    launch=launch,
                    node_bin=None,
                    ripgrep=None,
                    superseded=lambda: False,
                    engine_factory=FakeEngine,  # type: ignore[arg-type]
                )
    finally:
        held.close()

    assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert FakeEngine.made == []
