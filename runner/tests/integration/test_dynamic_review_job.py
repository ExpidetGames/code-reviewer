# SPDX-License-Identifier: Apache-2.0

"""Pins down `run_dynamic_job` with the prepared export of #196 wired in (#197).

The whole runner path runs unchanged: the `prepare` seam yields the verified preparation, the real
loopback proxy and a protocol-shaped fake engine (a subprocess) stand in for the model boundary, and
a fake OpenRouter-shaped upstream for the provider. Nothing here is a real model or network call.
"""

import json
import os
import socket
import sys
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from test_dynamic_review_engine import (
    CAPABILITIES,
    FAKE_ENGINE,
    HEAD,
    FakeUpstream,
    asks,
    findings,
    read_result,
    tool_call,
)

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.self_check import DEFAULT_TOOLS
from code_reviewer_runner.dynamic_review.supervisor import Prepared
from code_reviewer_runner.job import parse_job
from code_reviewer_runner.result import ErrorCode


def job_for(
    upstream_url: str,
    *,
    model: str = "deepseek-v4.1-flash",
    upstream_model: str = "deepseek/deepseek-v4.1-flash",
    api_key: str = "dummy-openrouter-key-0123456789",
) -> Any:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": model,
                    "skill": "Look.",
                    "limits": {"maxFindings": 5},
                },
                "base": {
                    "repository": "octo/repo",
                    "baseRef": "main",
                    "headSha": HEAD,
                    "previousReviewedSha": None,
                    "comparison": "full",
                },
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": "dummy-installation-token-0123456789",
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {
                    "provider": "openrouter",
                    "model": upstream_model,
                    "apiKey": api_key,
                    "baseUrl": upstream_url,
                },
            }
        )
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
        files={"src/api/handler.ts": "x\n"},
        diff="diff --git a/src/api/handler.ts b/src/api/handler.ts\n+x\n",
        previous_diff="",
        omissions=(),
        skipped=(),
        metadata=json.dumps({"title": "Add the handler", "body": "Why it is needed."}),
        prior_state="",
        deadline=0.0,
    )


class Preparer:
    """A `prepare` seam that records its lifetime around the engine."""

    def __init__(self, export: Path, script: dict[str, Any]) -> None:
        self.export = export
        self.script = script
        self.events: list[str] = []

    def __call__(self, job: Any) -> Any:
        @contextmanager
        def lifetime() -> Generator[PreparedContent]:
            self.export.mkdir(parents=True)
            (self.export / ".fake-opencode-script.json").write_text(json.dumps(self.script))
            self.events.append("prepared")
            try:
                yield content_at(self.export)
            finally:
                self.events.append("released")

        return lifetime()


def environment() -> dict[str, str]:
    return {
        runner.OPENCODE_COMMAND_VARIABLE: f"{sys.executable} {FAKE_ENGINE}",
        runner.DYNAMIC_CAPABILITIES_VARIABLE: CAPABILITIES,
        # The fake engine never searches; the production default (a ripgrep is required) stays.
    }


@pytest.fixture(autouse=True)
def fake_engine_needs_no_ripgrep(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # `run_dynamic_job` hands the engine the verified ripgrep of the image (`DEFAULT_TOOLS`) and the
    # adapter requires it to be an executable file named `rg`; the fake engine has no search tool,
    # so an empty executable stands in for it.
    ripgrep = tmp_path / "tools" / "rg"
    ripgrep.parent.mkdir()
    ripgrep.write_text("#!/bin/sh\n", encoding="utf-8")
    ripgrep.chmod(0o755)
    monkeypatch.setattr(runner, "DEFAULT_TOOLS", replace(DEFAULT_TOOLS, ripgrep=ripgrep))


# #197-T01
def test_a_dynamic_job_runs_on_the_prepared_export_and_releases_it_afterwards(
    tmp_path: Path,
) -> None:
    script = {
        "proxy_calls": 2,
        "answer": "structured",
        "findings": findings(),
        "results": {"c1": read_result("src/api/handler.ts")},
    }
    preparer = Preparer(tmp_path / "export", script)

    with FakeUpstream(
        [
            asks(tool_call("c1", "read", {"filePath": "src/api/handler.ts"})),
            asks(tool_call("c2", "StructuredOutput", findings())),
        ]
    ) as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
        )

    assert result.ok, result.log_tail
    assert result.usage is not None and result.usage.ai_calls == 2
    assert preparer.events == ["prepared", "released"]
    # The model was given the real title, body and diff of the preparation.
    trace = [
        json.loads(line)
        for line in (tmp_path / "export" / ".fake-opencode-trace.jsonl").read_text().splitlines()
    ]
    prompt = next(e["message_request"] for e in trace if "message_request" in e)["parts"][0]["text"]
    assert "Add the handler" in prompt and "Why it is needed." in prompt
    assert "diff --git a/src/api/handler.ts" in prompt


# #197-T13
def test_a_finding_outside_the_prepared_export_fails_the_job(tmp_path: Path) -> None:
    document = findings()
    document["findings"][0]["path"] = "src/not-in-the-export.ts"
    preparer = Preparer(
        tmp_path / "export", {"proxy_calls": 1, "answer": "structured", "findings": document}
    )

    with FakeUpstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
        )

    assert not result.ok
    assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
    assert preparer.events == ["prepared", "released"]


# #197-T06
def test_a_preparation_that_fails_is_its_stable_code_and_no_engine_starts(
    tmp_path: Path,
) -> None:
    @contextmanager
    def refusing(job: Any) -> Generator[PreparedContent]:
        raise CheckoutError(ErrorCode.CHECKOUT_INCOMPLETE)
        yield content_at(tmp_path)  # pragma: no cover

    with FakeUpstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=refusing,
        )

    assert not result.ok
    assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
    assert upstream.requests == []


# Two different, compatible model and provider configurations. Nothing in them is known to the
# code: different logical and upstream model names, different destination paths and keys, and
# different usage shapes (one with detail counters that are already part of the totals).
MODEL_FIXTURES = {
    "default": {
        "model": "deepseek-v4.1-flash",
        "upstream_model": "deepseek/deepseek-v4.1-flash",
        "api_key": "dummy-key-for-the-first-provider-0123",
        "prefix": "/api/v1",
        "usage": {
            "prompt_tokens": 40,
            "completion_tokens": 9,
            "completion_tokens_details": {"reasoning_tokens": 5},
        },
    },
    "alternative": {
        "model": "acme-large-2",
        "upstream_model": "acme-corp/large-2-instruct",
        "api_key": "dummy-key-for-the-second-provider-4567",
        "prefix": "/openai/v1",
        "usage": {
            "prompt_tokens": 61,
            "completion_tokens": 12,
            "total_tokens": 73,
            "prompt_tokens_details": {"cached_tokens": 30},
        },
    },
}


# #197-T10
@pytest.mark.parametrize("name", sorted(MODEL_FIXTURES))
def test_a_configured_model_and_provider_run_through_the_same_protocol_without_special_cases(
    tmp_path: Path, name: str
) -> None:
    fixture = MODEL_FIXTURES[name]
    usage: dict[str, Any] = fixture["usage"]  # pyright: ignore[reportAssignmentType]
    script = {
        "proxy_calls": 2,
        "answer": "structured",
        "findings": findings(),
        "results": {"c1": read_result("src/api/handler.ts")},
    }
    preparer = Preparer(tmp_path / "export", script)

    with FakeUpstream(
        [
            asks(tool_call("c1", "read", {"filePath": "src/api/handler.ts"})),
            asks(tool_call("c2", "StructuredOutput", findings())),
        ],
        usage=usage,
    ) as upstream:
        result = runner.run_dynamic_job(
            job_for(
                f"{upstream.url}{fixture['prefix']}",
                model=str(fixture["model"]),
                upstream_model=str(fixture["upstream_model"]),
                api_key=str(fixture["api_key"]),
            ),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
        )

    assert result.ok, result.log_tail
    # The selected model, destination and key were used exactly as configured, for every call, and
    # nothing about a hosting provider or a route was added.
    assert len(upstream.requests) == 2
    for (headers, body), path in zip(upstream.requests, upstream.paths, strict=True):
        assert path == f"{fixture['prefix']}/chat/completions"
        assert body["model"] == fixture["upstream_model"]
        assert headers["Authorization"] == f"Bearer {fixture['api_key']}"
        assert not {"provider", "route", "models", "transforms"} & set(body)
    # The engine was pointed at the logical model of the job, through the one local provider.
    trace = [
        json.loads(line)
        for line in (tmp_path / "export" / ".fake-opencode-trace.jsonl").read_text().splitlines()
    ]
    request = next(e["message_request"] for e in trace if "message_request" in e)
    assert request["model"]["modelID"] == fixture["model"]
    # The reported usage is summed over the real calls; detail counters are not added twice, and
    # cost is not guessed.
    assert result.usage is not None
    assert result.usage.model == fixture["upstream_model"]
    assert result.usage.ai_calls == 2
    assert result.usage.prompt_tokens == 2 * usage["prompt_tokens"]
    assert result.usage.completion_tokens == 2 * usage["completion_tokens"]
    assert result.usage.total_tokens == 2 * (usage["prompt_tokens"] + usage["completion_tokens"])
    assert result.usage.cost_usd is None
    assert result.usage.fallback_used is False


class LaunchedPreparer(Preparer):
    """A `Preparer` that also hands out the supervisor's launch for the slot (#244)."""

    def __init__(self, export: Path, script: dict[str, Any], launch: EngineLaunch) -> None:
        super().__init__(export, script)
        self.launch = launch

    def __call__(self, job: Any) -> Any:
        inner = super().__call__(job)

        @contextmanager
        def lifetime() -> Generator[Prepared]:
            with inner as content:
                yield Prepared(content, self.launch)

        return lifetime()


def slot_launch(tmp_path: Path, proxy_port: int) -> EngineLaunch:
    (tmp_path / "job").mkdir()
    return EngineLaunch(
        uid=os.getuid(),
        gid=os.getgid(),
        home=str(tmp_path),
        tmpdir=str(tmp_path),
        config_dir=tmp_path / "job",
        proxy_port=proxy_port,
        engine_port=proxy_port + 1,
    )


# #244-T04
def test_a_slot_whose_proxy_port_is_held_by_somebody_else_fails_closed_before_any_engine(
    tmp_path: Path,
) -> None:
    with socket.socket() as stranger:
        stranger.bind(("127.0.0.1", 0))
        stranger.listen(1)
        taken = int(stranger.getsockname()[1])
        preparer = LaunchedPreparer(tmp_path / "export", {}, slot_launch(tmp_path, taken))

        with FakeUpstream() as upstream:
            result = runner.run_dynamic_job(
                job_for(f"{upstream.url}/v1"),
                None,
                0.0,
                environment(),
                engines=ALL_ENGINES,
                prepare=preparer,
            )

    assert not result.ok
    assert result.error_code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert upstream.requests == []
    assert preparer.events == ["prepared", "released"]
    assert not (tmp_path / "export" / ".fake-opencode-trace.jsonl").exists()


# #202-T04
def test_a_job_without_the_verified_ripgrep_file_does_not_start_the_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        runner, "DEFAULT_TOOLS", replace(DEFAULT_TOOLS, ripgrep=tmp_path / "missing" / "rg")
    )
    preparer = Preparer(tmp_path / "export", {"proxy_calls": 0, "answer": "structured"})

    with FakeUpstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
        )

    assert not result.ok
    assert result.error_code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert not (tmp_path / "export" / ".fake-opencode-trace.jsonl").exists()
