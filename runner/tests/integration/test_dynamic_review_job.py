# SPDX-License-Identifier: Apache-2.0

"""Pins down `run_dynamic_job` with the prepared export of #196 wired in (#197).

The whole runner path runs unchanged: the `prepare` seam yields the verified preparation, the real
loopback proxy and a protocol-shaped fake engine (a subprocess) stand in for the model boundary, and
a fake OpenRouter-shaped upstream for the provider. Nothing here is a real model or network call.
"""

import json
import os
import re
import socket
import sys
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from fake_github_comments import FakeGithubComments
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
from code_reviewer_runner.dynamic_findings import DynamicFindings
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.limits import (
    CheckoutError,
    CheckoutMetrics,
    CheckoutReason,
)
from code_reviewer_runner.dynamic_review.publish import (
    IDENTITY_MARKER,
    STATE_RESET_CODE,
    Published,
    PublishError,
)
from code_reviewer_runner.dynamic_review.supervisor import Prepared
from code_reviewer_runner.dynamic_review.wrap_up import (
    FINAL_ATTEMPTS,
    RECOVERY_INSTRUCTION,
    WRAP_UP_INSTRUCTION,
)
from code_reviewer_runner.job import parse_job
from code_reviewer_runner.result import ErrorCode


def job_document(
    upstream_url: str,
    *,
    model: str = "deepseek/deepseek-v4.1-flash",
    upstream_model: str = "deepseek/deepseek-v4.1-flash",
    api_key: str = "dummy-openrouter-key-0123456789",
    pr_url: str = "https://github.com/octo/repo/pull/7",
    git_base_url: str = "https://api.github.com",
    git_token: str = "dummy-installation-token-0123456789",
    require_parameters: bool | None = None,
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "prUrl": pr_url,
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
            "baseUrl": git_base_url,
            "token": git_token,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {
            "provider": "openrouter",
            "model": upstream_model,
            "apiKey": api_key,
            "baseUrl": upstream_url,
        },
    }
    if require_parameters is not None:
        # What a test double that stands in for OpenRouter adds next to its address (#270).
        document["llm"]["requireParameters"] = require_parameters
    return document


def job_for(upstream_url: str, **options: Any) -> Any:
    return parse_job(json.dumps(job_document(upstream_url, **options)))


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
        metrics=CheckoutMetrics(0, 0, 0, 1, {}, {}),
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
        # The fake engine never searches; the production default (a verified ripgrep is required)
        # stays: the loop names it, the fixture below provides one.
        runner.RIPGREP_PATH_VARIABLE: str(FAKE_RIPGREP["path"]),
    }


# The file the loop would name as the verified ripgrep; set per test by the fixture below.
FAKE_RIPGREP: dict[str, Path] = {}


@pytest.fixture(autouse=True)
def fake_engine_needs_no_ripgrep(tmp_path: Path) -> None:
    # `run_dynamic_job` requires the verified ripgrep the loop names to be an executable file called
    # `rg`; the fake engine has no search tool, so an empty executable stands in for it.
    ripgrep = tmp_path / "tools" / "rg"
    ripgrep.parent.mkdir()
    ripgrep.write_text("#!/bin/sh\n", encoding="utf-8")
    ripgrep.chmod(0o755)
    FAKE_RIPGREP["path"] = ripgrep


# #270-T07
@pytest.mark.parametrize("fake_asks", [True, False])
def test_a_dynamic_run_against_a_fake_llm_sends_required_parameters_only_when_the_fake_asks(
    tmp_path: Path, fake_asks: bool
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
            job_for(f"{upstream.url}/v1", require_parameters=fake_asks),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=RecordingPublisher(),
        )

    assert result.ok, result.log_tail
    assert len(upstream.requests) == 2
    for _headers, body in upstream.requests:
        assert body.get("provider") == ({"require_parameters": True} if fake_asks else None)


# #293-T07, #293-T08
def test_a_run_at_its_cost_limit_is_wrapped_up_published_and_marked(tmp_path: Path) -> None:
    script = {"proxy_calls": 1, "answer": "structured", "findings": findings(), "results": {}}
    preparer = Preparer(tmp_path / "export", script)
    publisher = RecordingPublisher()

    with FakeUpstream([asks(tool_call("c1", "StructuredOutput", findings()))]) as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            # One call is reserved at about 0.016 USD (4,096 output tokens), so a call after
            # which no final call fits is the final call: the first one.
            {**environment(), runner.DYNAMIC_MAX_COST_VARIABLE: "0.02"},
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert result.ok, result.log_tail
    # The only request the provider saw is the final one: the return tool alone, instruction last.
    assert len(upstream.requests) == 1
    _headers, body = upstream.requests[0]
    assert [tool["function"]["name"] for tool in body["tools"]] == ["StructuredOutput"]
    assert body["tool_choice"] == "required"
    assert body["messages"][-1] == {"role": "user", "content": WRAP_UP_INSTRUCTION}
    # The review is published, with the reason, and the Run's usage says it stopped early.
    assert len(publisher.calls) == 1
    assert publisher.calls[0][1].stopped_early == "cost_limit"
    assert result.usage is not None
    assert result.usage.stopped_early == "cost_limit"
    assert result.usage.to_json()["stoppedEarly"] == "cost_limit"


# #309-T01, #309-T08
def test_a_turn_without_an_answer_is_recovered_published_and_marked_in_the_log(
    tmp_path: Path,
) -> None:
    script = {
        "proxy_calls": 1,
        "answers": ["none", "structured"],
        "findings": findings(),
        "results": {},
    }
    preparer = Preparer(tmp_path / "export", script)
    publisher = RecordingPublisher()

    with FakeUpstream(
        [
            {"role": "assistant", "content": "my review in prose"},
            asks(tool_call("c1", "StructuredOutput", findings())),
        ]
    ) as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert result.ok, result.log_tail
    # Two provider calls: the first ended the turn, the second is the recovery call, which the proxy
    # reduced to the return tool alone with the runner's instruction last.
    assert len(upstream.requests) == 2
    _headers, recovery = upstream.requests[1]
    assert [tool["function"]["name"] for tool in recovery["tools"]] == ["StructuredOutput"]
    assert recovery["tool_choice"] == "required"
    assert recovery["messages"][-1] == {"role": "user", "content": RECOVERY_INSTRUCTION}
    # The review is published as a complete one: a recovery is no limit, so there is no notice.
    assert len(publisher.calls) == 1
    assert publisher.calls[0][1].stopped_early is None
    assert result.usage is not None
    assert result.usage.stopped_early is None
    # The result line says so, with how the first turn ended and the time of both message calls.
    assert (
        "recovered after a turn without an answer (finish=stop, error=StructuredOutputError)"
        in (result.log_tail)
    )
    assert re.search(r"engine message call: \d+\.\d s, \d+\.\d s", result.log_tail), result.log_tail


# #309-T04, #309-T08
def test_a_recovery_that_also_has_no_answer_fails_with_the_same_code_and_says_so(
    tmp_path: Path,
) -> None:
    script = {"proxy_calls": 1, "answers": ["none"], "findings": findings(), "results": {}}
    preparer = Preparer(tmp_path / "export", script)
    publisher = RecordingPublisher()

    with FakeUpstream([{"role": "assistant", "content": "prose"}]) as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert not result.ok
    assert result.error_code is ErrorCode.LLM_OUTPUT_INVALID
    first_line = result.log_tail.splitlines()[0]
    assert first_line.startswith("llm_output_invalid: the engine returned no structured answer")
    assert (
        "after one recovery; the first turn: finish=stop, error=StructuredOutputError" in first_line
    )
    assert re.search(r"\[engine message call: \d+\.\d s, \d+\.\d s\]$", first_line), first_line
    # One normal call and one recovery turn, whose call asked again (#312), bounded.
    assert len(upstream.requests) == 1 + FINAL_ATTEMPTS
    assert publisher.calls == []


# #293-T16
def test_the_result_log_names_how_long_the_engine_message_call_took(tmp_path: Path) -> None:
    script = {"proxy_calls": 1, "answer": "structured", "findings": findings(), "results": {}}
    preparer = Preparer(tmp_path / "export", script)

    with FakeUpstream([asks(tool_call("c1", "StructuredOutput", findings()))]) as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=RecordingPublisher(),
        )

    assert result.ok, result.log_tail
    assert re.search(r"engine message call: \d+\.\d s", result.log_tail), result.log_tail


# #293-T16
def test_a_failed_run_names_how_long_the_message_call_took_after_the_code(
    tmp_path: Path,
) -> None:
    script = {"proxy_calls": 1, "answer": "structured", "findings": findings(), "results": {}}
    preparer = Preparer(tmp_path / "export", script)

    with FakeUpstream([asks(tool_call("c1", "StructuredOutput", findings()))], status=401) as bad:
        result = runner.run_dynamic_job(
            job_for(f"{bad.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=RecordingPublisher(),
        )

    assert not result.ok
    assert result.error_code is ErrorCode.LLM_AUTH
    first_line = result.log_tail.splitlines()[0]
    assert first_line.startswith("llm_auth:")
    assert re.search(r"\[engine message call: \d+\.\d s\]$", first_line), first_line


# #293-T07
def test_a_complete_run_is_published_without_the_mark(tmp_path: Path) -> None:
    script = {"proxy_calls": 1, "answer": "structured", "findings": findings(), "results": {}}
    preparer = Preparer(tmp_path / "export", script)
    publisher = RecordingPublisher()

    with FakeUpstream([asks(tool_call("c1", "StructuredOutput", findings()))]) as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert result.ok, result.log_tail
    assert publisher.calls[0][1].stopped_early is None
    assert result.usage is not None
    assert result.usage.stopped_early is None
    assert "stoppedEarly" not in result.usage.to_json()


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
            publish=RecordingPublisher(),
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


# #257-T06
@pytest.mark.parametrize("reset", [True, False])
def test_a_state_reset_is_named_in_the_result_log_and_only_then(
    tmp_path: Path, reset: bool
) -> None:
    script = {
        "proxy_calls": 2,
        "answer": "structured",
        "findings": findings(),
        "results": {"c1": read_result("src/api/handler.ts")},
    }
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
            prepare=Preparer(tmp_path / "export", script),
            publish=RecordingPublisher(reset=reset),
        )

    assert result.ok, result.log_tail
    assert (STATE_RESET_CODE in result.log_tail) is reset


# #296-T13
def test_a_finding_outside_the_prepared_export_is_dropped_and_counted_not_failed(
    tmp_path: Path,
) -> None:
    document = findings()
    document["findings"].append({**document["findings"][0], "id": "f-2", "path": "outside.ts"})
    preparer = Preparer(
        tmp_path / "export", {"proxy_calls": 1, "answer": "structured", "findings": document}
    )
    publisher = RecordingPublisher(preparer)

    with FakeUpstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert result.ok, result.log_tail
    assert len(publisher.calls[0][1].findings) == len(document["findings"]) - 1
    assert "outside.ts" not in result.log_tail
    assert "dropped 1 finding(s): finding_path_not_exported" in result.log_tail
    assert preparer.events == ["prepared", "released", "published"]


# #312-T02
def test_an_invalid_finding_is_dropped_and_named_in_the_log_not_failed(tmp_path: Path) -> None:
    document = findings()
    document["findings"].append(
        {**document["findings"][0], "id": "f-2", "lineStart": 9, "lineEnd": 1, "body": "SECRET"}
    )
    preparer = Preparer(
        tmp_path / "export", {"proxy_calls": 1, "answer": "structured", "findings": document}
    )
    publisher = RecordingPublisher(preparer)

    with FakeUpstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert result.ok, result.log_tail
    assert len(publisher.calls[0][1].findings) == len(document["findings"]) - 1
    assert "dropped 1 finding(s): finding_invalid (lineStart must not be after lineEnd)" in (
        result.log_tail
    )
    assert "SECRET" not in result.log_tail


# #197-T06
def test_a_preparation_that_fails_is_its_stable_code_and_no_engine_starts(
    tmp_path: Path,
) -> None:
    @contextmanager
    def refusing(job: Any) -> Generator[PreparedContent]:
        raise CheckoutError(CheckoutReason.INVALID_REQUEST, ErrorCode.CHECKOUT_INCOMPLETE)
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


# #296-T09 #296-T12
def test_a_failed_preparation_reports_its_reason_and_metrics_without_any_content(
    tmp_path: Path,
) -> None:
    @contextmanager
    def refusing(job: Any) -> Generator[PreparedContent]:
        error = CheckoutError(CheckoutReason.BUDGET_PREPARATION)
        error.metrics = CheckoutMetrics(10, 20, 30, 4, {"binary": 1}, {"too_large": 2})
        raise error
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

    assert result.error_reason == "budget_preparation"
    assert json.loads(result.to_line())["errorReason"] == "budget_preparation"
    lines = result.log_tail.splitlines()
    assert lines[0] == (
        "checkout_incomplete [budget_preparation]: the pull request could not be prepared"
    )
    assert (
        "checkout: transfer=10 preparation=20 exposed=30 entries=4 "
        "omitted=binary:1 skipped=too_large:2"
    ) in lines


# #296-T12
def test_a_good_run_logs_the_checkout_metrics(tmp_path: Path) -> None:
    script = {
        "proxy_calls": 2,
        "answer": "structured",
        "findings": findings(),
        "results": {"c1": read_result("src/api/handler.ts")},
    }
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
            prepare=Preparer(tmp_path / "export", script),
            publish=RecordingPublisher(),
        )

    assert result.ok, result.log_tail
    assert result.error_reason is None
    assert "checkout: transfer=0 preparation=0 exposed=0 entries=1 omitted=none skipped=none" in (
        result.log_tail
    )


# Two different, compatible model and provider configurations. Nothing in them is known to the
# code: different logical and upstream model names, different destination paths and keys, and
# different usage shapes (one with detail counters that are already part of the totals).
MODEL_FIXTURES = {
    "default": {
        "model": "deepseek/deepseek-v4.1-flash",
        "upstream_model": "deepseek/deepseek-v4.1-flash",
        "api_key": "dummy-key-for-the-first-provider-0123",
        "prefix": "/api/v1",
        "usage": {
            "prompt_tokens": 40,
            "completion_tokens": 9,
            "cost": 0.0003,
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
            "cost": 0.0004,
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
            publish=RecordingPublisher(),
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
    # the cost is what the provider reported for each call, never guessed.
    assert result.usage is not None
    assert result.usage.model == fixture["upstream_model"]
    assert result.usage.ai_calls == 2
    assert result.usage.prompt_tokens == 2 * usage["prompt_tokens"]
    assert result.usage.completion_tokens == 2 * usage["completion_tokens"]
    assert result.usage.total_tokens == 2 * (usage["prompt_tokens"] + usage["completion_tokens"])
    assert result.usage.cost_usd == pytest.approx(2 * usage["cost"], rel=0, abs=1e-12)
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
@pytest.mark.parametrize("named", [None, "missing"])
def test_a_job_without_the_verified_ripgrep_file_does_not_start_the_engine(
    tmp_path: Path, named: str | None
) -> None:
    env = environment()
    if named is None:
        del env[runner.RIPGREP_PATH_VARIABLE]
    else:
        env[runner.RIPGREP_PATH_VARIABLE] = str(tmp_path / named / "rg")
    preparer = Preparer(tmp_path / "export", {"proxy_calls": 0, "answer": "structured"})

    with FakeUpstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            env,
            engines=ALL_ENGINES,
            prepare=preparer,
        )

    assert not result.ok
    assert result.error_code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert not (tmp_path / "export" / ".fake-opencode-trace.jsonl").exists()


class RecordingPublisher:
    """The `publish` seam: records what the job published, and when relative to the export."""

    URL = "https://github.com/octo/repo/pull/7#issuecomment-4001"

    def __init__(
        self,
        preparer: Preparer | None = None,
        *,
        fail: PublishError | None = None,
        reset: bool = False,
    ) -> None:
        self.reset = reset
        self.calls: list[tuple[Any, DynamicFindings]] = []
        self.preparer = preparer
        self.fail = fail

    def __call__(
        self, job: Any, found: DynamicFindings, may_write: Callable[[], bool] | None = None
    ) -> Published:
        # `may_write` is the supersede check the entry point passes right before the write (#396).
        self.calls.append((job, found))
        if self.preparer is not None:
            self.preparer.events.append("published")
        if self.fail is not None:
            raise self.fail
        return Published(comment_url=self.URL, created=True, reset=self.reset)


def query_findings() -> dict[str, Any]:
    """The findings of the runs below. (The redaction of the summary also blanks a phrase such as
    "authorization check", so the title of the shared `findings()` would not read back.)"""
    document = findings()
    document["findings"][0]["title"] = "Query text built from the request"
    return document


def structured_script() -> dict[str, Any]:
    return {
        "proxy_calls": 2,
        "answer": "structured",
        "findings": query_findings(),
        "results": {"c1": read_result("src/api/handler.ts")},
    }


def reading_upstream() -> FakeUpstream:
    return FakeUpstream(
        [
            asks(tool_call("c1", "read", {"filePath": "src/api/handler.ts"})),
            asks(tool_call("c2", "StructuredOutput", query_findings())),
        ]
    )


# #253-R01
def test_a_successful_dynamic_job_publishes_its_findings_once_after_the_export_is_released(
    tmp_path: Path,
) -> None:
    preparer = Preparer(tmp_path / "export", structured_script())
    publisher = RecordingPublisher(preparer)

    with reading_upstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert result.ok, result.log_tail
    # The summary is written by the supervisor, once, after the engine and its export are gone.
    assert preparer.events == ["prepared", "released", "published"]
    assert len(publisher.calls) == 1
    published_job, published = publisher.calls[0]
    assert published_job.base.head_sha == HEAD
    assert published.reviewed_sha == HEAD
    assert [item.id for item in published.findings] == ["f-1"]
    # The Runs page links to the comment the run wrote.
    assert result.comment_url == RecordingPublisher.URL


# #253-R02
@pytest.mark.parametrize(
    "code",
    [ErrorCode.GIT_RATE_LIMIT, ErrorCode.REVIEW_TEXT_TRUNCATED, ErrorCode.DYNAMIC_POLICY_VIOLATION],
)
def test_a_publication_that_fails_fails_the_job_with_its_own_code_and_links_no_comment(
    tmp_path: Path, code: ErrorCode
) -> None:
    preparer = Preparer(tmp_path / "export", structured_script())
    publisher = RecordingPublisher(
        preparer, fail=PublishError(code, "the comment could not be written")
    )

    with reading_upstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert not result.ok
    assert result.error_code is code
    assert result.comment_url is None
    assert len(publisher.calls) == 1


# #253-R03
def test_a_job_whose_engine_fails_writes_nothing_to_the_pull_request(tmp_path: Path) -> None:
    # An answer about another head is an engine failure (a finding outside the export is not).
    document = findings()
    other = "0" * 40
    document["reviewedSha"] = other
    document["findings"][0]["reviewedSha"] = other
    preparer = Preparer(
        tmp_path / "export", {"proxy_calls": 1, "answer": "structured", "findings": document}
    )
    publisher = RecordingPublisher(preparer)

    with FakeUpstream() as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=preparer,
            publish=publisher,
        )

    assert not result.ok
    assert publisher.calls == []


# #253-R04
def test_by_default_the_job_writes_one_summary_comment_through_the_github_api_of_its_own_job(
    tmp_path: Path,
) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    github = FakeGithubComments(token=token)
    preparer = Preparer(tmp_path / "export", structured_script())
    try:
        with reading_upstream() as upstream:
            result = runner.run_dynamic_job(
                job_for(
                    f"{upstream.url}/v1",
                    pr_url=f"{github.url}/octo/repo/pull/7",
                    git_base_url=github.url,
                    git_token=token,
                ),
                None,
                0.0,
                environment(),
                engines=ALL_ENGINES,
                prepare=preparer,
            )

        assert result.ok, result.log_tail
        assert len(github.comments) == 1
        body = str(github.comments[0]["body"])
        assert IDENTITY_MARKER in body
        assert "Query text built from the request" in body
        assert result.comment_url == github.comments[0]["html_url"]
        # Only the job's own pull request was touched, and only through its comments.
        assert all("/issues/" in path for _, path in github.requests)
    finally:
        github.stop()


# #283-T08
def test_the_published_summary_never_names_the_model_of_the_job(tmp_path: Path) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    model = "acme-tier/deep-reviewer-7"
    github = FakeGithubComments(token=token)
    preparer = Preparer(tmp_path / "export", structured_script())
    try:
        with reading_upstream() as upstream:
            result = runner.run_dynamic_job(
                job_for(
                    f"{upstream.url}/v1",
                    model=model,
                    upstream_model=model,
                    pr_url=f"{github.url}/octo/repo/pull/7",
                    git_base_url=github.url,
                    git_token=token,
                ),
                None,
                0.0,
                environment(),
                engines=ALL_ENGINES,
                prepare=preparer,
            )

        assert result.ok, result.log_tail
        # The model did the work (it is the model of the requests) and is nowhere in the comment.
        assert {body["model"] for _, body in upstream.requests} == {model}
        assert len(github.comments) == 1
        published = json.dumps(github.comments)
        assert "deep-reviewer" not in published
        assert "acme-tier" not in published
    finally:
        github.stop()


# #283-T08
def test_the_failure_note_never_names_the_model_of_the_job(tmp_path: Path) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    model = "acme-tier/deep-reviewer-7"
    github = FakeGithubComments(token=token)
    try:
        with FakeUpstream() as upstream:
            result = runner.run_dynamic_job(
                job_for(
                    f"{upstream.url}/v1",
                    model=model,
                    upstream_model=model,
                    pr_url=f"{github.url}/octo/repo/pull/7",
                    git_base_url=github.url,
                    git_token=token,
                ),
                None,
                0.0,
                environment(),
                engines=ALL_ENGINES,
                prepare=refusing_checkout(),
            )

        assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
        assert len(github.comments) == 1
        published = json.dumps(github.comments)
        assert "Dynamic Review did not complete" in published
        assert "deep-reviewer" not in published
        assert "acme-tier" not in published
    finally:
        github.stop()


# #253-R05
def test_a_second_job_for_the_same_pull_request_edits_the_summary_comment_and_adds_none(
    tmp_path: Path,
) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    github = FakeGithubComments(token=token)
    # Somebody else quotes the identity marker; it is not the bot's summary and must stay as it is.
    quote = github.seed(f"{IDENTITY_MARKER}\nquoted by a person", author="octocat")
    try:
        links: list[str | None] = []
        for name in ("first", "second"):
            with reading_upstream() as upstream:
                result = runner.run_dynamic_job(
                    job_for(
                        f"{upstream.url}/v1",
                        pr_url=f"{github.url}/octo/repo/pull/7",
                        git_base_url=github.url,
                        git_token=token,
                    ),
                    None,
                    0.0,
                    environment(),
                    engines=ALL_ENGINES,
                    prepare=Preparer(tmp_path / name, structured_script()),
                )
            assert result.ok, result.log_tail
            links.append(result.comment_url)

        summaries = [c for c in github.comments if c["user"]["login"] == "code-reviewer[bot]"]
        assert len(summaries) == 1
        assert len(github.comments) == 2
        assert links == [summaries[0]["html_url"]] * 2
        assert github.comments[0]["body"] == quote["body"]
        assert [m for m, _ in github.requests if m == "POST"] == ["POST"]
        assert "PATCH" in [m for m, _ in github.requests]
    finally:
        github.stop()


def refusing_checkout(reason: CheckoutReason = CheckoutReason.BUDGET_PREPARATION) -> Any:
    @contextmanager
    def refusing(job: Any) -> Generator[PreparedContent]:
        raise CheckoutError(reason)
        yield  # pragma: no cover

    return refusing


def run_failing_job(github: FakeGithubComments, token: str, prepare: Any) -> Any:
    with FakeUpstream() as upstream:
        return runner.run_dynamic_job(
            job_for(
                f"{upstream.url}/v1",
                pr_url=f"{github.url}/octo/repo/pull/7",
                git_base_url=github.url,
                git_token=token,
            ),
            None,
            0.0,
            environment(),
            engines=ALL_ENGINES,
            prepare=prepare,
        )


# #299-T01 #299-T03
def test_by_default_a_failed_run_writes_one_note_into_the_summary_and_a_repeat_updates_it(
    tmp_path: Path,
) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    github = FakeGithubComments(token=token)
    try:
        first = run_failing_job(github, token, refusing_checkout())
        second = run_failing_job(github, token, refusing_checkout())

        for result in (first, second):
            # The run keeps its own failure; the note is only an addition.
            assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
            assert result.comment_url is None
        assert len(github.comments) == 1
        body = str(github.comments[0]["body"])
        assert IDENTITY_MARKER in body
        assert "Dynamic Review did not complete" in body
        assert "`checkout_incomplete`" in body
        assert "`budget_preparation`" in body
        assert [m for m, _ in github.requests if m == "POST"] == ["POST"]
        assert "PATCH" in [m for m, _ in github.requests]
    finally:
        github.stop()


# #299-T05
def test_by_default_a_failed_run_keeps_the_findings_of_an_earlier_review(tmp_path: Path) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    github = FakeGithubComments(token=token)
    try:
        with reading_upstream() as upstream:
            reviewed = runner.run_dynamic_job(
                job_for(
                    f"{upstream.url}/v1",
                    pr_url=f"{github.url}/octo/repo/pull/7",
                    git_base_url=github.url,
                    git_token=token,
                ),
                None,
                0.0,
                environment(),
                engines=ALL_ENGINES,
                prepare=Preparer(tmp_path / "first", structured_script()),
            )
        assert reviewed.ok, reviewed.log_tail

        failed = run_failing_job(github, token, refusing_checkout())

        assert failed.error_code is ErrorCode.CHECKOUT_INCOMPLETE
        assert len(github.comments) == 1
        body = str(github.comments[0]["body"])
        assert "Query text built from the request" in body
        assert "Dynamic Review did not complete" in body
    finally:
        github.stop()


# #299-T07
def test_a_note_that_cannot_be_written_leaves_the_run_with_its_own_failure(
    tmp_path: Path,
) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    github = FakeGithubComments(token=token)
    github.faults["GET"] = (403, {})
    try:
        result = run_failing_job(github, token, refusing_checkout())

        assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
        assert result.error_reason == "budget_preparation"
        assert "failure note: not written (git_forbidden)" in result.log_tail
        assert github.comments == []
    finally:
        github.stop()


# #299-T06
def test_a_lost_token_writes_no_note(tmp_path: Path) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    github = FakeGithubComments(token=token)
    try:
        with FakeUpstream() as upstream:
            result = runner.run_dynamic_job(
                job_for(
                    f"{upstream.url}/v1",
                    pr_url=f"{github.url}/octo/repo/pull/7",
                    git_base_url=github.url,
                    git_token=token,
                ),
                None,
                0.0,
                environment(),
                engines=ALL_ENGINES,
                prepare=refusing_checkout_with(ErrorCode.GIT_AUTH),
            )

        assert result.error_code is ErrorCode.GIT_AUTH
        assert github.comments == []
        assert github.requests == []
    finally:
        github.stop()


def refusing_checkout_with(code: ErrorCode) -> Any:
    @contextmanager
    def refusing(job: Any) -> Generator[PreparedContent]:
        raise CheckoutError(CheckoutReason.TRANSPORT, code)
        yield  # pragma: no cover

    return refusing


# #299-T02
def test_the_note_of_a_run_whose_log_holds_repository_text_holds_none_of_it(
    tmp_path: Path,
) -> None:
    token = "ghs_dummy-installation-token-0123456789"
    github = FakeGithubComments(token=token)
    secret = "sk-or-dummy-secret-value-0123456789"
    path = "/srv/work/customer-repo/src/billing/invoice.py"
    diff_line = "+    charge(card_number='4111-1111-1111-1111')"

    @contextmanager
    def hostile(job: Any) -> Generator[PreparedContent]:
        # What a preparation could carry in its message and its metrics: none of it may be copied.
        error = CheckoutError(CheckoutReason.BUDGET_PREPARATION)
        error.args = (f"{path} {diff_line} {secret}",)
        error.metrics = CheckoutMetrics(10, 20, 30, 4, {"binary": 1}, {"too_large": 2})
        raise error
        yield content_at(tmp_path)  # pragma: no cover

    try:
        result = run_failing_job(github, token, hostile)

        assert result.error_code is ErrorCode.CHECKOUT_INCOMPLETE
        body = str(github.comments[0]["body"])
        for fragment in (path, "billing", "invoice", diff_line, "card_number", secret, "omitted="):
            assert fragment not in body
    finally:
        github.stop()


# #387-T04: a run that starts late gets the time that is left, so a hung provider ends it at the
# soft timeout of the process (counted from its start) and never at the watchdog's.
def test_a_dynamic_run_after_a_slow_start_is_ended_by_the_time_that_is_left(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deadlines: list[float] = []
    real = runner.dynamic_ledger

    def spy(capabilities: Any, environment: Any, deadline: float) -> Any:
        deadlines.append(deadline)
        return real(capabilities, environment, deadline)

    monkeypatch.setattr(runner, "dynamic_ledger", spy)
    script = {"proxy_calls": 1, "answer": "structured", "findings": findings(), "results": {}}
    began = time.monotonic()

    with FakeUpstream(hold=60.0) as upstream:
        result = runner.run_dynamic_job(
            job_for(f"{upstream.url}/v1"),
            None,
            began - 4.0,  # a start-up of 4 s, beyond the 3 s the watchdog allows after the timeout
            environment(),
            5.0,
            engines=ALL_ENGINES,
            prepare=Preparer(tmp_path / "export", script),
            publish=RecordingPublisher(),
        )

    (deadline,) = deadlines
    assert 0 < deadline <= 1.0  # the 5 s timeout minus the 4 s that are gone
    assert result.ok is False
    assert result.error_code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert result.error_reason is None  # the run's own result, not the watchdog's unknown outcome
    assert time.monotonic() - began < 15.0
