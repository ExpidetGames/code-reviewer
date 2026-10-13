# SPDX-License-Identifier: Apache-2.0

"""Pins down `run_dynamic_job` with the prepared export of #196 wired in (#197).

The whole runner path runs unchanged: the `prepare` seam yields the verified preparation, the real
loopback proxy and a protocol-shaped fake engine (a subprocess) stand in for the model boundary, and
a fake OpenRouter-shaped upstream for the provider. Nothing here is a real model or network call.
"""

import json
import sys
from collections.abc import Generator
from contextlib import contextmanager
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
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.job import parse_job
from code_reviewer_runner.result import ErrorCode


def job_for(upstream_url: str) -> Any:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": "deepseek-v4.1-flash",
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
                    "model": "deepseek/deepseek-v4.1-flash",
                    "apiKey": "dummy-openrouter-key-0123456789",
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
def fake_engine_needs_no_ripgrep(monkeypatch: pytest.MonkeyPatch) -> None:
    # `run_dynamic_job` builds the engine with the production default (ripgrep required); the fake
    # engine in these tests has no search tool, so the preflight is satisfied by the test host.
    def ripgrep_found(*args: object, **kwargs: object) -> str:
        return "/usr/bin/rg"

    monkeypatch.setattr("code_reviewer_runner.dynamic_review.adapter.shutil.which", ripgrep_found)


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
