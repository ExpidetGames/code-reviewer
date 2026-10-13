# SPDX-License-Identifier: Apache-2.0

"""Pins down the Dynamic Review adapter against a protocol-shaped fake engine (#197).

The production adapter, its HTTP client, the trusted config generation and the real loopback model
proxy run unchanged; a scripted fake of the pinned server stands in for the engine and a fake
OpenRouter-shaped upstream stands in for the provider. Nothing here is a real model or network call:
both servers are loopback fakes, and the engine is a subprocess the test starts and the adapter
ends.
"""

import json
import os
import socket
import sys
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, EngineAnswer
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.config import engine_environment, new_proxy_capability
from code_reviewer_runner.dynamic_review.prompts import compose_system_prompt
from code_reviewer_runner.dynamic_review.proxy import ModelProxy, capabilities_from_config
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.result import ErrorCode

FAKE_ENGINE = Path(__file__).parent / "fake_opencode.py"
TOKEN = "dummy-installation-token-0123456789"
API_KEY = "dummy-openrouter-key-0123456789"
HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
OTHER_SHA = "0000000000000000000000000000000000000000"
CAPABILITIES = json.dumps(
    {"tool_choice_required": True, "structured_output": True, "max_output_tokens": 4096}
)
UPSTREAM_USAGE = {"prompt_tokens": 11, "completion_tokens": 7}


class FakeUpstream:
    """An OpenRouter-shaped provider: records every request, answers with usage."""

    def __init__(self) -> None:
        self.requests: list[tuple[dict[str, str], Any]] = []

        test = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body: Any = json.loads(self.rfile.read(length))
                headers = {key: value for key, value in self.headers.items()}
                test.requests.append((headers, body))
                payload = json.dumps(
                    {
                        "id": "chatcmpl-1",
                        "choices": [{"message": {"role": "assistant", "content": "{}"}}],
                        "usage": UPSTREAM_USAGE,
                    }
                ).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "FakeUpstream":
        self._thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)


def dynamic_job() -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/7",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": "deepseek-v4.1-flash",
                    "skill": "Look for real bugs.",
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
                    "token": TOKEN,
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {
                    "provider": "openrouter",
                    "model": "deepseek/deepseek-v4.1-flash",
                    "apiKey": API_KEY,
                },
            }
        )
    )


def findings(reviewed_sha: str = HEAD, *, body: str = "Why it happens.") -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "reviewedSha": reviewed_sha,
        "resolvedIds": [],
        "findings": [
            {
                "id": "f-1",
                "priority": "P1",
                "confidence": 0.6,
                "title": "Missing authorization check",
                "body": body,
                "path": "src/api/handler.ts",
                "lineStart": 4,
                "lineEnd": 9,
                "evidence": ["src/api/handler.ts:4"],
                "reviewedSha": reviewed_sha,
            }
        ],
    }


def tool_part(call_id: str, tool: str, path: str, output: str) -> dict[str, Any]:
    return {
        "type": "tool",
        "callID": call_id,
        "tool": tool,
        "state": {"input": {"filePath": path}, "output": output, "metadata": {"lines": 3}},
    }


def search_part(call_id: str, tool: str, pattern: str) -> dict[str, Any]:
    """A grep/glob tool part: its input is a pattern, not a file."""
    return {
        "type": "tool",
        "callID": call_id,
        "tool": tool,
        "state": {"input": {"pattern": pattern}, "output": "matches", "metadata": {}},
    }


def findings_of(count: int) -> dict[str, Any]:
    document = findings()
    template = document["findings"][0]
    document["findings"] = [{**template, "id": f"f-{index}"} for index in range(count)]
    return document


class Fixture:
    """One scripted engine: the script, the trace and the running fakes."""

    def __init__(
        self,
        tmp_path: Path,
        script: dict[str, Any],
        limits: DynamicLimits | None = None,
        port_source: Callable[[], int] | None = None,
    ) -> None:
        self.directory = tmp_path / "export"
        self.directory.mkdir(parents=True)
        self.script_path = self.directory / ".fake-opencode-script.json"
        self.script_path.write_text(json.dumps(script), encoding="utf-8")
        self.trace_path = self.directory / ".fake-opencode-trace.jsonl"
        self.ledger = BudgetLedger(limits or DynamicLimits())
        self.port_source = port_source
        self.capability = ""

    def traces(self) -> list[dict[str, Any]]:
        if not self.trace_path.is_file():
            return []
        return [
            json.loads(line)
            for line in self.trace_path.read_text(encoding="utf-8").splitlines()
            if line
        ]

    def run(self, upstream: FakeUpstream) -> EngineAnswer:
        capability = new_proxy_capability()
        self.capability = capability
        proxy = ModelProxy(
            ledger=self.ledger,
            base_path="/v1",
            model="deepseek-v4.1-flash",
            upstream_url=f"{upstream.url}/v1/chat/completions",
            upstream_api_key=API_KEY,
            upstream_model="deepseek/deepseek-v4.1-flash",
            capabilities=capabilities_from_config(CAPABILITIES),
            capability=capability,
        )
        server = proxy.serve("127.0.0.1").start()
        try:
            job = dynamic_job()
            dynamic = job.dynamic
            base = job.base
            assert dynamic is not None and base is not None
            engine = DynamicEngine(
                job,
                ledger=self.ledger,
                command=[sys.executable, str(FAKE_ENGINE)],
                directory=str(self.directory),
                proxy_url=server.url,
                proxy_capability=capability,
                agent_prompt=compose_system_prompt(dynamic.skill, base.head_sha),
                model_schema=findings_schema(),
                startup_seconds=2.0,
                port_source=self.port_source or free_port,
            )
            return engine.run()
        finally:
            server.stop()


def process_is_gone(pid: int) -> bool:
    for _ in range(40):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


# #197-T01
def test_the_adapter_drives_the_engine_and_returns_the_validated_findings(tmp_path: Path) -> None:
    script = {
        "proxy_calls": 2,
        "answer": "structured",
        "findings": findings(),
        "messages": [
            {
                "parts": [
                    tool_part("c1", "read", "src/api/handler.ts", "content of the file"),
                    tool_part("c2", "grep", "src/other.ts", "another result"),
                ]
            }
        ],
        "spawn_helper": True,
    }
    fixture = Fixture(tmp_path, script)

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    assert answer.findings is not None
    assert answer.findings.reviewed_sha == HEAD
    assert [finding.id for finding in answer.findings.findings] == ["f-1"]

    # The engine reached the model through the runner's proxy, which rewrote the model and supplied
    # the workspace credential: the engine never held it.
    assert fixture.ledger.model_calls == 2
    assert len(upstream.requests) == 2
    headers, body = upstream.requests[0]
    assert headers["Authorization"] == f"Bearer {API_KEY}"
    assert body["model"] == "deepseek/deepseek-v4.1-flash"

    usage = fixture.ledger.usage("deepseek/deepseek-v4.1-flash")
    assert usage.prompt_tokens == 2 * UPSTREAM_USAGE["prompt_tokens"]
    assert usage.completion_tokens == 2 * UPSTREAM_USAGE["completion_tokens"]
    assert usage.ai_calls == 2

    # The tool loop the engine reported is counted: tools, distinct files and result bytes.
    assert fixture.ledger.tool_calls == 2
    assert fixture.ledger.files == 2
    assert fixture.ledger.returned_bytes > 0

    # The trusted config the runner wrote carries the fixed core and the claim's head, and no
    # untrusted head: the engine received it through the trusted channel.
    config = next(entry for entry in fixture.traces() if entry.get("config"))
    agent = config["config"]["agent"]["review"]
    assert HEAD in agent["prompt"]
    assert OTHER_SHA not in agent["prompt"]
    assert agent["tools"]["*"] is False
    # The engine's only credential is the job's proxy capability, never the workspace key; the
    # authenticated calls above (model_calls == 2) prove the proxy accepted exactly that one.
    engine_key = config["config"]["provider"]["review-proxy"]["options"]["apiKey"]
    assert engine_key != API_KEY and len(engine_key) >= 43
    assert API_KEY not in json.dumps(config["config"])

    # Ending the job ended the whole owned process group, helper included.
    pid = next(entry["pid"] for entry in fixture.traces() if "pid" in entry)
    helper = next(entry["helper_pid"] for entry in fixture.traces() if "helper_pid" in entry)
    assert process_is_gone(pid)
    assert process_is_gone(helper)


# #197-T05
def test_a_run_whose_tool_parts_cannot_be_observed_fails_closed(tmp_path: Path) -> None:
    # #85: with a stored JSON-schema format the pinned message list answers 400. The structured
    # answer still arrived, but the tool limits could not be accounted for: the run is not a
    # success with zero accounting.
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "messages_status": 400, "proxy_calls": 1},
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.findings is None
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
    assert any(entry.get("messages_status") == 400 for entry in fixture.traces())


# #197-T05
def test_a_malformed_message_list_or_tool_part_fails_closed(tmp_path: Path) -> None:
    malformed: list[Any] = [
        {"error": "not a list"},
        "text",
        [{"parts": []}, "not a message"],
        # A tool part without a state: its result bytes cannot be counted.
        [{"parts": [{"type": "tool", "callID": "c1", "tool": "read"}]}],
    ]
    for index, body in enumerate(malformed):
        (tmp_path / str(index)).mkdir()
        fixture = Fixture(
            tmp_path / str(index),
            {
                "answer": "structured",
                "findings": findings(),
                "proxy_calls": 1,
                "messages_body": body,
            },
        )

        with FakeUpstream() as upstream:
            answer = fixture.run(upstream)

        assert not answer.ok, body
        assert answer.error is not None
        assert answer.error.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED, body


# #197-T05
def test_a_session_without_tool_calls_is_an_observed_empty_list_and_succeeds(
    tmp_path: Path,
) -> None:
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "proxy_calls": 1, "messages": []},
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    assert fixture.ledger.tool_calls == 0


# #197-T13
def test_a_json_answer_in_a_text_part_is_accepted_and_validated(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, {"answer": "text", "findings": findings(), "proxy_calls": 1})

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    assert answer.findings is not None


# #197-T06
def test_an_engine_that_never_becomes_healthy_is_a_stable_error(tmp_path: Path) -> None:
    fixture = Fixture(
        tmp_path, {"version": "1.20.0", "answer": "structured", "findings": findings()}
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE


# #197-T06
def test_an_engine_without_a_structured_answer_is_a_bad_output_error(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, {"answer": "none", "proxy_calls": 1})

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.LLM_OUTPUT_INVALID


# #197-T13
def test_an_answer_made_against_another_head_is_a_policy_violation(tmp_path: Path) -> None:
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(OTHER_SHA), "proxy_calls": 1},
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_POLICY_VIOLATION


# #197-T05
def test_a_tool_result_over_the_per_result_bound_fails_the_run(tmp_path: Path) -> None:
    big = "x" * (64 * 1024 + 1)
    fixture = Fixture(
        tmp_path,
        {
            "answer": "structured",
            "findings": findings(),
            "proxy_calls": 1,
            "messages": [{"parts": [tool_part("c1", "read", "src/api/handler.ts", big)]}],
        },
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


# #197-T07
def test_an_engine_that_exits_before_answering_leaves_no_process_behind(tmp_path: Path) -> None:
    # A health answer from the wrong version is the shape of an engine that is not the pinned one.
    fixture = Fixture(tmp_path, {"version": "0.0.0", "spawn_helper": True})

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    for entry in fixture.traces():
        if "pid" in entry:
            assert process_is_gone(entry["pid"])


def test_the_engine_answers_over_its_own_loopback_port(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings(), "proxy_calls": 1})

    with FakeUpstream() as upstream:
        fixture.run(upstream)

    # The engine really was a separate HTTP server on loopback: it called the proxy.
    assert fixture.ledger.model_calls == 1


# #197-T02
def test_the_engine_process_receives_only_the_closed_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The runner's own environment is full of credentials; none of it may reach the engine child.
    for name, value in {
        "GITHUB_TOKEN": "ghs_runner_token_value",
        "OPENROUTER_API_KEY": API_KEY,
        "RUNNER_TOKEN": "runner-token-value",
        "AWS_SECRET_ACCESS_KEY": "aws-secret-value",
        "LEAKED_SENTINEL": "must-not-reach-the-engine",
        "HTTP_PROXY": "http://proxy.invalid:3128",
        "XDG_CONFIG_HOME": "/runner/config",
        "HOME": "/runner/home",
    }.items():
        monkeypatch.setenv(name, value)
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings(), "proxy_calls": 1})

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    environment: dict[str, str] = next(entry["env"] for entry in fixture.traces() if "env" in entry)
    permitted = {
        *engine_environment(proxy_url="", home="", scratch_dir=""),
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_DIR",
        # Set by the Python interpreter of the fake itself, not by the runner.
        "LC_CTYPE",
    }
    assert set(environment) <= permitted
    assert environment["HOME"] != "/runner/home"
    assert environment["XDG_CONFIG_HOME"] != "/runner/config"
    joined = "\n".join(environment.values())
    for secret in ("ghs_runner_token_value", API_KEY, "aws-secret-value", fixture.capability):
        assert secret not in joined


# #197-T05
def test_a_search_pattern_is_not_counted_as_a_file(tmp_path: Path) -> None:
    fixture = Fixture(
        tmp_path,
        {
            "answer": "structured",
            "findings": findings(),
            "proxy_calls": 1,
            "messages": [
                {
                    "parts": [
                        search_part("c1", "grep", "TODO"),
                        search_part("c2", "glob", "**/*.ts"),
                        tool_part("c3", "read", "src/api/handler.ts", "content"),
                    ]
                }
            ],
        },
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    assert fixture.ledger.tool_calls == 3
    assert fixture.ledger.files == 1


# #197-T12
def test_the_untrusted_input_over_the_input_bound_is_refused_before_the_engine_sees_it(
    tmp_path: Path,
) -> None:
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "proxy_calls": 1},
        limits=DynamicLimits(max_input_bytes=10),
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert not any("message_request" in entry for entry in fixture.traces())
    assert upstream.requests == []


# #197-T13
def test_the_job_finding_bound_narrows_the_schema_and_the_accepted_answer(tmp_path: Path) -> None:
    # The job names at most 5 findings (the packaged schema allows 30).
    within = Fixture(
        tmp_path / "within", {"answer": "structured", "findings": findings_of(5), "proxy_calls": 1}
    )
    over = Fixture(
        tmp_path / "over", {"answer": "structured", "findings": findings_of(6), "proxy_calls": 1}
    )

    with FakeUpstream() as upstream:
        accepted = within.run(upstream)
        refused = over.run(upstream)

    assert accepted.ok
    sent = next(e["message_request"] for e in within.traces() if "message_request" in e)
    schema = sent["format"]["schema"]
    assert schema["$defs"]["DynamicFindings"]["properties"]["findings"]["maxItems"] == 5
    # The packaged schema itself is shared and stays untouched.
    assert findings_schema()["$defs"]["DynamicFindings"]["properties"]["findings"]["maxItems"] == 30

    assert not refused.ok
    assert refused.error is not None
    assert refused.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED


class Occupant:
    """A loopback listener that holds a port and answers every request 503, like a stranger."""

    def __init__(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(503)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


# #197-T07
def test_a_port_taken_between_probe_and_bind_is_retried_on_another_port(tmp_path: Path) -> None:
    occupant = Occupant()
    ports = iter([occupant.port, free_port()])
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "proxy_calls": 1},
        port_source=lambda: next(ports),
    )
    try:
        with FakeUpstream() as upstream:
            answer = fixture.run(upstream)
    finally:
        occupant.close()

    # The first engine could not bind its port (a stranger held it), exited, and was replaced; the
    # run did not talk to the stranger and does not fail because of it.
    assert answer.ok
    pids = [entry["pid"] for entry in fixture.traces() if "pid" in entry]
    assert len(pids) == 2
    for pid in pids:
        assert process_is_gone(pid)


# #197-T07
def test_an_engine_that_never_gets_a_port_is_a_stable_error(tmp_path: Path) -> None:
    occupant = Occupant()
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings()},
        port_source=lambda: occupant.port,
    )
    try:
        with FakeUpstream() as upstream:
            answer = fixture.run(upstream)
    finally:
        occupant.close()

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
