# SPDX-License-Identifier: Apache-2.0

"""Pins down the Dynamic Review adapter against a protocol-shaped fake engine (#197).

The production adapter, its HTTP client, the trusted config generation and the real loopback model
proxy run unchanged; a scripted fake of the pinned server stands in for the engine and a fake
OpenRouter-shaped upstream stands in for the provider. Nothing here is a real model or network call:
both servers are loopback fakes, and the engine is a subprocess the test starts and the adapter
ends. The fake engine sends the model requests the way the real one does (streamed, with the whole
tool history in every request), so the proxy-side audit is what these tests exercise; the real
binary is covered by the engine suite (`tests/engine/test_engine_opencode.py`).
"""

import json
import os
import socket
import stat
import sys
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review import adapter as adapter_module
from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import (
    DynamicEngine,
    EngineAnswer,
    shutdown_engines,
)
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.config import engine_environment, new_proxy_capability
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs, compose_system_prompt
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
EXPORTED = frozenset({"src/api/handler.ts", "src/other.ts"})


def tool_call(call_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def asks(*calls: dict[str, Any]) -> dict[str, Any]:
    """An assistant message that asks for tool calls."""
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def read_result(path: str, text: str = "content of the file") -> str:
    """The shape of a file result of the pinned `read` tool."""
    return (
        f"<path>{path}</path>\n<type>file</type>\n<content>\n1: {text}\n\n"
        "(End of file - total 1 lines)\n</content>"
    )


def grep_result(*paths: str) -> str:
    """The shape of a result of the pinned `grep` tool."""
    return f"Found {len(paths)} matches\n" + "".join(f"{path}:\n  Line 1: x\n" for path in paths)


class FakeUpstream:
    """An OpenRouter-shaped provider: records every request, answers with usage.

    `answers` are the assistant messages in order (the last one repeats); without any the model
    answers `{}` in prose. `usage` is what every answer reports. `status` makes every call fail
    like a provider error; `hold` makes a call wait (a hung provider) until the test ends.
    """

    def __init__(
        self,
        answers: list[dict[str, Any]] | None = None,
        *,
        status: int = 200,
        hold: float = 0.0,
        usage: dict[str, Any] | None = None,
    ) -> None:
        self.requests: list[tuple[dict[str, str], Any]] = []
        self.paths: list[str] = []
        self._usage = usage or UPSTREAM_USAGE
        self._answers = answers or [{"role": "assistant", "content": "{}"}]
        self._status = status
        self._hold = hold
        self._released = threading.Event()

        test = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body: Any = json.loads(self.rfile.read(length))
                headers = {key: value for key, value in self.headers.items()}
                test.requests.append((headers, body))
                test.paths.append(self.path)
                if test._hold:
                    test._released.wait(test._hold)
                index = min(len(test.requests) - 1, len(test._answers) - 1)
                payload = json.dumps(
                    {
                        "id": "chatcmpl-1",
                        "choices": [{"message": test._answers[index], "finish_reason": "stop"}],
                        "usage": test._usage,
                    }
                ).encode()
                self.send_response(test._status)
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
        self._released.set()
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
        self.exported: frozenset[str] = EXPORTED
        self.launch: EngineLaunch | None = None

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
        proxy.audit.set_export_root(str(self.directory))
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
                inputs=ReviewInputs(
                    pr_url=job.pr_url,
                    pr_title="Add the handler",
                    pr_body="Adds src/api/handler.ts.",
                    diff="diff --git a/src/api/handler.ts b/src/api/handler.ts\n+new\n",
                ),
                exported_paths=self.exported,
                require_ripgrep=False,  # the fake engine never searches
                startup_seconds=2.0,
                port_source=self.port_source or free_port,
                launch=self.launch,
            )
            return engine.run()
        finally:
            server.stop()


def leader_is_unreaped(pid: int) -> bool:
    """True while the process is still our child (running or a zombie), so its id is still ours."""
    try:
        os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return False
    return True


def watch_group_signals(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, bool]]:
    """Record every process-group signal as (group id, whether the leader was still unreaped)."""
    signals: list[tuple[int, bool]] = []
    real_killpg = os.killpg

    def killpg(pgid: int, sig: int) -> None:
        signals.append((pgid, leader_is_unreaped(pgid)))
        real_killpg(pgid, sig)

    monkeypatch.setattr(adapter_module.os, "killpg", killpg)
    return signals


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
        "proxy_calls": 3,
        "answer": "structured",
        "findings": findings(),
        "results": {
            "c1": read_result("src/api/handler.ts"),
            "c2": grep_result(str(tmp_path / "export" / "src" / "other.ts")),
        },
        "spawn_helper": True,
    }
    fixture = Fixture(tmp_path, script)
    handler = {"filePath": "src/api/handler.ts"}

    with FakeUpstream(
        [
            asks(tool_call("c1", "read", handler), tool_call("c2", "grep", {"pattern": "x"})),
            asks(tool_call("c3", "StructuredOutput", findings())),
        ]
    ) as upstream:
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
    # The engine streams; the provider was asked for the whole answer.
    assert body["stream"] is False and "stream_options" not in body

    usage = fixture.ledger.usage("deepseek/deepseek-v4.1-flash")
    assert usage.prompt_tokens == 2 * UPSTREAM_USAGE["prompt_tokens"]
    assert usage.completion_tokens == 2 * UPSTREAM_USAGE["completion_tokens"]
    assert usage.ai_calls == 2

    # The tool loop is audited at the proxy from the requests themselves: three calls (the final
    # StructuredOutput included), two distinct files, and the bytes the model was shown.
    assert fixture.ledger.tool_calls == 3
    assert fixture.ledger.files == 2
    assert fixture.ledger.returned_bytes > 0

    # The trusted config the runner wrote carries the fixed core and the claim's head, and no
    # untrusted head: the engine received it through the trusted channel.
    config = next(entry for entry in fixture.traces() if entry.get("config"))
    agent = config["config"]["agent"]["review"]
    assert HEAD in agent["prompt"]
    assert OTHER_SHA not in agent["prompt"]
    assert "tools" not in agent
    # The engine's only credential is the job's proxy capability, never the workspace key; the
    # authenticated calls above (model_calls == 2) prove the proxy accepted exactly that one.
    engine_key = config["config"]["provider"]["review-proxy"]["options"]["apiKey"]
    assert engine_key != API_KEY and len(engine_key) >= 43
    assert API_KEY not in json.dumps(config["config"])

    # The model received the real title, body and diff of the preparation, and the schema it was
    # asked to answer in has an object root.
    request = next(e["message_request"] for e in fixture.traces() if "message_request" in e)
    prompt = request["parts"][0]["text"]
    assert "Add the handler" in prompt and "Adds src/api/handler.ts." in prompt
    assert "diff --git a/src/api/handler.ts" in prompt
    assert request["format"]["schema"]["type"] == "object"
    assert "$defs" not in request["format"]["schema"]

    # Ending the job ended the whole owned process group, helper included.
    pid = next(entry["pid"] for entry in fixture.traces() if "pid" in entry)
    helper = next(entry["helper_pid"] for entry in fixture.traces() if "helper_pid" in entry)
    assert process_is_gone(pid)
    assert process_is_gone(helper)


# #197-T13
def test_the_message_list_defect_of_the_pinned_server_cannot_fail_or_blind_a_run(
    tmp_path: Path,
) -> None:
    # #85: with a stored JSON-schema format the pinned message list answers 400. The run does not
    # read the list at all (the audit is at the proxy), so the defect neither fails the run nor
    # leaves it unaccounted: the tool call below is counted from the model request.
    fixture = Fixture(
        tmp_path,
        {
            "answer": "structured",
            "findings": findings(),
            "messages_status": 400,
            "proxy_calls": 2,
            "results": {"c1": read_result("src/api/handler.ts")},
        },
    )

    with FakeUpstream(
        [
            asks(tool_call("c1", "read", {"filePath": "src/api/handler.ts"})),
            asks(tool_call("c2", "StructuredOutput", findings())),
        ]
    ) as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    assert fixture.ledger.tool_calls == 2
    assert fixture.ledger.files == 1
    assert not any(entry.get("messages_requested") for entry in fixture.traces())


# #231-T05
def test_a_second_call_that_would_cross_the_token_cap_is_refused_before_the_provider(
    tmp_path: Path,
) -> None:
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "proxy_calls": 3},
        limits=DynamicLimits(max_total_tokens=6_000),
    )

    # Each call reserves its request (a few hundred bytes) plus the 4096 output tokens the
    # descriptor allows, so each fits 6,000 alone. The first settles at 4097; the second would end
    # above the cap and never leaves the proxy.
    with FakeUpstream(
        [
            asks(tool_call("c1", "read", {"filePath": "src/api/handler.ts"})),
            asks(tool_call("c3", "StructuredOutput", findings())),
        ],
        usage={"prompt_tokens": 1, "completion_tokens": 4096},
    ) as upstream:
        answer = fixture.run(upstream)
    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert len(upstream.requests) == 1
    assert fixture.ledger.model_calls == 1
    answers = next(e["proxy_answers"] for e in fixture.traces() if "proxy_answers" in e)
    assert answers == [200, 403]


# #197-T05
def test_a_tool_result_over_the_per_result_bound_is_never_forwarded(tmp_path: Path) -> None:
    big = read_result("src/api/handler.ts", "x" * (64 * 1024 + 1))
    fixture = Fixture(
        tmp_path,
        {
            "answer": "structured",
            "findings": findings(),
            "proxy_calls": 3,
            "results": {"c1": big},
        },
    )

    with FakeUpstream(
        [
            asks(tool_call("c1", "read", {"filePath": "src/api/handler.ts"})),
            asks(tool_call("c2", "StructuredOutput", findings())),
        ]
    ) as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    # Preventive: the oversized content is in no request the provider received.
    assert len(upstream.requests) == 1
    assert "x" * 1000 not in json.dumps(upstream.requests)


# #197-T05
def test_the_tool_call_that_crosses_the_bound_is_not_handed_to_the_engine(tmp_path: Path) -> None:
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "proxy_calls": 3},
        limits=DynamicLimits(max_tool_calls=2),
    )

    with FakeUpstream(
        [
            asks(tool_call("c1", "read", {"filePath": "src/a.ts"})),
            asks(
                tool_call("c2", "read", {"filePath": "src/b.ts"}),
                tool_call("c3", "read", {"filePath": "src/c.ts"}),
            ),
        ]
    ) as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    # The answer with the third call was refused at the proxy: the engine got a 403, not the call.
    answers = next(e["proxy_answers"] for e in fixture.traces() if "proxy_answers" in e)
    assert answers == [200, 403]


# #197-T05
def test_grep_and_glob_count_the_files_they_name_not_their_patterns(tmp_path: Path) -> None:
    export = str(tmp_path / "export")
    fixture = Fixture(
        tmp_path,
        {
            "answer": "structured",
            "findings": findings(),
            "proxy_calls": 4,
            "results": {
                "c1": grep_result(f"{export}/src/api/handler.ts", f"{export}/src/other.ts"),
                "c2": f"{export}/src/api/handler.ts\n{export}/src/other.ts",
            },
        },
    )

    with FakeUpstream(
        [
            asks(tool_call("c1", "grep", {"pattern": "TODO"})),
            asks(tool_call("c2", "glob", {"pattern": "**/*.ts"})),
            asks(tool_call("c3", "StructuredOutput", findings())),
        ]
    ) as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    assert fixture.ledger.tool_calls == 3
    # Two files, whichever tool named them and however they were spelled: one identity each.
    assert fixture.ledger.files == 2


# #197-T05
def test_a_file_over_the_distinct_file_bound_fails_the_run_at_the_proxy(tmp_path: Path) -> None:
    export = str(tmp_path / "export")
    fixture = Fixture(
        tmp_path,
        {
            "answer": "structured",
            "findings": findings(),
            "proxy_calls": 3,
            "results": {"c1": grep_result(f"{export}/a.ts", f"{export}/b.ts", f"{export}/c.ts")},
        },
        limits=DynamicLimits(max_files=2),
    )

    with FakeUpstream(
        [
            asks(tool_call("c1", "grep", {"pattern": "x"})),
            asks(tool_call("c2", "StructuredOutput", findings())),
        ]
    ) as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert len(upstream.requests) == 1


# #197-T06
def test_a_provider_refusal_is_the_stable_result_of_the_run(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings(), "proxy_calls": 2})

    with FakeUpstream(status=401) as upstream:
        answer = fixture.run(upstream)

    # The engine saw an HTTP error and still sent an answer; the run is the provider's code, never a
    # success and never a generic engine failure.
    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.LLM_AUTH


# #197-T06
def test_a_hung_provider_ends_the_run_at_the_whole_job_deadline(tmp_path: Path) -> None:
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "proxy_calls": 1},
        limits=DynamicLimits(deadline_seconds=1.0),
    )

    started = time.monotonic()
    with FakeUpstream(hold=30.0) as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert time.monotonic() - started < 15.0
    pid = next(entry["pid"] for entry in fixture.traces() if "pid" in entry)
    assert process_is_gone(pid)


# #197-T13
def test_a_finding_outside_the_verified_export_is_rejected(tmp_path: Path) -> None:
    document = findings()
    document["findings"][0]["path"] = "src/not-in-the-export.ts"
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": document, "proxy_calls": 1})

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.CHECKOUT_INCOMPLETE


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
        # Set by the Python interpreter of the fake itself, not by the runner.
        "LC_CTYPE",
    }
    assert set(environment) <= permitted
    assert environment["HOME"] != "/runner/home"
    assert environment["XDG_CONFIG_HOME"] != "/runner/config"
    joined = "\n".join(environment.values())
    for secret in ("ghs_runner_token_value", API_KEY, "aws-secret-value", fixture.capability):
        assert secret not in joined
    trace_startup = next(entry for entry in fixture.traces() if "config_mode" in entry)
    assert trace_startup["config_mode"] == 0o600
    assert trace_startup["scratch_mode"] == 0o700


# #197-T02
def test_the_engine_config_file_is_mode_0600_and_scratch_dir_0700(tmp_path: Path) -> None:
    job = dynamic_job()
    dynamic = job.dynamic
    base = job.base
    assert dynamic is not None and base is not None
    export_dir = tmp_path / "export"
    export_dir.mkdir(parents=True)
    engine = DynamicEngine(
        job,
        ledger=BudgetLedger(DynamicLimits()),
        command=[sys.executable, str(FAKE_ENGINE)],
        directory=str(export_dir),
        proxy_url="http://127.0.0.1:9",
        proxy_capability=new_proxy_capability(),
        agent_prompt=compose_system_prompt(dynamic.skill, base.head_sha),
        model_schema=findings_schema(),
        inputs=ReviewInputs(pr_url=job.pr_url, pr_title="t", pr_body="b", diff=""),
        exported_paths=frozenset(),
        require_ripgrep=False,
        startup_seconds=2.0,
    )
    _ = engine.start()
    try:
        scratch_dir = engine._scratch  # pyright: ignore[reportPrivateUsage]
        config_path = scratch_dir / "opencode.json"
        assert config_path.is_file()
        assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(scratch_dir.stat().st_mode) == 0o700
    finally:
        engine.stop()


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
    assert schema["properties"]["findings"]["maxItems"] == 5
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


# #197-T07
def test_an_engine_without_ripgrep_on_its_path_is_not_started(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The pinned release downloads ripgrep from GitHub on the first grep when none is on its PATH:
    # a runtime download the runner refuses. The check happens before any process exists.
    def no_ripgrep(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr("code_reviewer_runner.dynamic_review.adapter.shutil.which", no_ripgrep)
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings()})
    job = dynamic_job()
    dynamic = job.dynamic
    assert dynamic is not None
    engine = DynamicEngine(
        job,
        ledger=fixture.ledger,
        command=[sys.executable, str(FAKE_ENGINE)],
        directory=str(fixture.directory),
        proxy_url="http://127.0.0.1:9",
        proxy_capability=new_proxy_capability(),
        agent_prompt="prompt",
        model_schema=findings_schema(),
        inputs=ReviewInputs(pr_url=job.pr_url, pr_title="t", pr_body="b", diff=""),
        exported_paths=frozenset(),
    )

    answer = engine.run()

    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert not fixture.trace_path.exists()


# #202 (process-group reuse)
def test_the_engine_group_is_only_signalled_while_its_leader_is_not_reaped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    signals = watch_group_signals(monkeypatch)
    fixture = Fixture(
        tmp_path,
        {"answer": "structured", "findings": findings(), "proxy_calls": 1, "spawn_helper": True},
    )

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert answer.ok
    assert signals
    # A reaped leader frees its id, which an unrelated process group could then reuse.
    assert all(unreaped for _, unreaped in signals)
    helper = next(entry["helper_pid"] for entry in fixture.traces() if "helper_pid" in entry)
    assert process_is_gone(helper)


# #202 (process-group reuse)
def test_an_engine_that_exited_on_its_own_is_not_reaped_before_its_group_is_ended(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    signals = watch_group_signals(monkeypatch)
    fixture = Fixture(tmp_path, {"exit_early": True})

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    # Looking whether the engine is alive must not reap it: the helper left in its group keeps the
    # group alive after the leader is gone, and the group is ended before the leader is reaped.
    assert signals
    assert all(unreaped for _, unreaped in signals)
    helpers = [entry["helper_pid"] for entry in fixture.traces() if "helper_pid" in entry]
    assert helpers
    assert all(process_is_gone(helper) for helper in helpers)


# #202 (process-group reuse)
def test_the_shutdown_of_the_engines_never_signals_a_finished_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings(), "proxy_calls": 1})
    with FakeUpstream() as upstream:
        assert fixture.run(upstream).ok
    signals = watch_group_signals(monkeypatch)

    shutdown_engines()

    # The group id of the finished run may belong to somebody else by now: nothing is signalled.
    assert signals == []


class ScriptedLaunch(EngineLaunch):
    """A dedicated-user launch without root: the user is the current one and the rules are noted.

    It records what the adapter asked of the boundary, in order; the real setuid, the nft rules
    and the leftover kill are proven as root by the privileged suite.
    """

    def __init__(self, tmp_path: Path) -> None:
        config_dir = tmp_path / "job"
        config_dir.mkdir(parents=True)
        (tmp_path / "home").mkdir()
        (tmp_path / "scratch").mkdir()
        super().__init__(
            uid=os.getuid(),
            gid=os.getgid(),
            home=str(tmp_path / "home"),
            tmpdir=str(tmp_path / "scratch"),
            config_dir=config_dir,
        )
        self.calls: list[str] = []
        self.refuse_network = False
        self.listener_is_ours = True

    def spawn_options(self) -> dict[str, Any]:
        self.calls.append("spawn_options")
        return {"umask": 0o077}  # a Popen keyword a non-root process may pass

    def confine(self, proxy_port: int, engine_port: int) -> None:
        self.calls.append(f"confine:{proxy_port}:{engine_port}")
        if self.refuse_network:
            raise IsolationError("the engine user can reach a service other than its model proxy")

    def owns_listener(self, port: int, *, tables: dict[str, str] | None = None) -> bool:
        self.calls.append(f"owns_listener:{port}")
        return self.listener_is_ours

    def sweep(self) -> bool:
        self.calls.append("sweep")
        return True

    def close(self) -> None:
        self.calls.append("close")


# #197-T04 #197-T09
def test_a_launched_engine_runs_behind_its_network_rules_and_in_its_users_directories(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings(), "proxy_calls": 1})
    launch = ScriptedLaunch(tmp_path / "launch")
    fixture.launch = launch

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert answer.ok, answer.error
    startup = next(entry for entry in fixture.traces() if "config_mode" in entry)
    # The config is the launch's file (mode 0400), not a runner scratch file; HOME is its home.
    assert startup["config_mode"] == 0o400
    assert startup["env"]["HOME"] == launch.home
    assert startup["env"]["TMPDIR"] == launch.tmpdir
    # The network rules come first (the proxy port, then the engine's own), the engine is started
    # with the launch's options, and nothing of the user is left at the end.
    confine = next(call for call in launch.calls if call.startswith("confine:"))
    proxy_port = int(confine.split(":")[1])
    assert proxy_port != int(confine.split(":")[2])
    assert launch.calls.index("spawn_options") > launch.calls.index(confine)
    assert launch.calls[-1] == "close"
    assert "sweep" in launch.calls
    # The job's lifetime owns the directories of the user; the adapter leaves them in place.
    assert Path(launch.home).is_dir() and Path(launch.tmpdir).is_dir()


# #197-T09
def test_a_network_boundary_that_cannot_be_proven_means_no_engine_at_all(tmp_path: Path) -> None:
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings(), "proxy_calls": 1})
    launch = ScriptedLaunch(tmp_path / "launch")
    launch.refuse_network = True
    fixture.launch = launch

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert fixture.traces() == []  # the engine never started
    assert upstream.requests == []
    assert "spawn_options" not in launch.calls
    assert launch.calls[-1] == "close"


# #197-T04
def test_an_answer_from_a_port_the_engine_user_does_not_hold_is_not_trusted(
    tmp_path: Path,
) -> None:
    fixture = Fixture(tmp_path, {"answer": "structured", "findings": findings(), "proxy_calls": 1})
    launch = ScriptedLaunch(tmp_path / "launch")
    launch.listener_is_ours = False
    fixture.launch = launch

    with FakeUpstream() as upstream:
        answer = fixture.run(upstream)

    assert not answer.ok
    assert answer.error is not None
    assert answer.error.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE
    assert not any("message_request" in entry for entry in fixture.traces())
    assert upstream.requests == []
    assert launch.calls[-1] == "close"


# #197-T07
def test_the_watchdog_also_ends_the_users_leftovers_and_rules(tmp_path: Path) -> None:
    launch = ScriptedLaunch(tmp_path / "launch")
    adapter_module._RUNNING_LAUNCHES.append(launch)  # pyright: ignore[reportPrivateUsage]

    adapter_module.shutdown_engines()
    adapter_module.shutdown_engines()  # twice is safe

    assert launch.calls == ["close"]
