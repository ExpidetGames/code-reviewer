# SPDX-License-Identifier: Apache-2.0

"""Support for the real pinned OpenCode engine tests (#197).

The engine under test is the real, unmodified `anomalyco/opencode` v1.19.0 executable that
`scripts/fetch_opencode.py` verified against `opencode-pin.json`. Everything around it is a loopback
fake: a scripted OpenAI-compatible model (`ScriptedModel`) behind the real runner-owned proxy, and a
hostile repository served by real Git objects through the real #196 preparation, so what the engine
reads is exactly what production would give it. No real model, network or credential is involved.
"""

import importlib.util
import json
import os
import shutil
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType
from typing import Any

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, EngineAnswer
from code_reviewer_runner.dynamic_review.audit import ToolAudit
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits, UnitCosts
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.inputs import review_inputs
from code_reviewer_runner.dynamic_review.prompts import compose_system_prompt
from code_reviewer_runner.dynamic_review.proxy import ModelProxy, capabilities_from_config
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.llm_providers import OPENROUTER

RUNNER = Path(__file__).resolve().parents[2]
API_KEY = "dummy-openrouter-key-0123456789"
CAPABILITIES = json.dumps(
    {
        "tool_choice_required": True,
        "structured_output": True,
        "max_output_tokens": 4096,
        "input_usd_per_mtok": 1,
        "output_usd_per_mtok": 4,
    }
)
# A directory holding trusted tools the engine needs on its PATH besides the system ones (a
# ripgrep when the machine has none). Unset on CI, where the image's `rg` is in /usr/bin.
EXTRA_PATH_VARIABLE = "OPENCODE_TEST_PATH"
BINARY_VARIABLE = "OPENCODE_BIN"


# 1 USD per million input tokens, 4 USD per million output tokens: a call has a price.
UNIT_COSTS = UnitCosts(input_usd_per_mtok=Decimal(1), output_usd_per_mtok=Decimal(4))


def _load_fetch_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "fetch_opencode", RUNNER / "scripts" / "fetch_opencode.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["fetch_opencode"] = module
    spec.loader.exec_module(module)
    return module


def opencode_binary() -> Path:
    """The verified pinned executable. Absence is a failure with the fix, never a skip."""
    override = os.environ.get(BINARY_VARIABLE)
    path = Path(override) if override else _load_fetch_script().default_destination() / "opencode"
    if not path.is_file():
        raise AssertionError(
            f"the pinned OpenCode is not installed ({path}): run "
            "`uv run python scripts/fetch_opencode.py` once (it needs the internet)"
        )
    return path


def extra_path() -> str | None:
    return os.environ.get(EXTRA_PATH_VARIABLE) or None


def ripgrep_binary() -> Path | None:
    """The `rg` of this host that stands in for the image's verified one (None when it has none)."""
    found = shutil.which("rg", path=f"{extra_path() or ''}:/usr/local/bin:/usr/bin:/bin")
    return Path(found) if found else None


def tool_call(call_id: str, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def asks(*calls: dict[str, Any]) -> dict[str, Any]:
    """An assistant message that asks for tool calls."""
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def says(text: str, finish_reason: str = "stop") -> dict[str, Any]:
    """An assistant message in prose (no tool call), ending with the given finish reason."""
    return {"role": "assistant", "content": text, "finish_reason": finish_reason}


# A step is the model's next message, or a function of the request that produced it.
Step = dict[str, Any] | Callable[[dict[str, Any]], dict[str, Any]]


@dataclass
class ScriptedModel:
    """A loopback OpenAI-compatible provider that answers the engine's tool loop from a script.

    Every request is recorded (the body as the provider received it from the runner's proxy).
    `steps` answer the requests that offer tools, in order; once they are used up the model returns
    the final structured answer through the engine's `StructuredOutput` tool. `status` makes every
    call fail like a provider error; `hold` makes a call wait (a hung provider).
    """

    steps: list[Step]
    final: dict[str, Any] | None = None
    status: int = 200
    hold: float = 0.0
    requests: list[dict[str, Any]] = field(default_factory=lambda: [])
    on_request: Callable[[int], None] | None = None
    # The charge every answer reports in `usage.cost`, like OpenRouter; None leaves it out.
    cost: float | None = 0.0001

    def __post_init__(self) -> None:
        self._released = threading.Event()
        model = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body: dict[str, Any] = json.loads(self.rfile.read(length))
                model.requests.append(body)
                if model.on_request is not None:
                    model.on_request(len(model.requests))
                if model.hold:
                    model._released.wait(model.hold)
                payload = json.dumps(model.answer(body)).encode()
                self.send_response(model.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def answer(self, body: dict[str, Any]) -> dict[str, Any]:
        offered: list[dict[str, Any]] = body.get("tools") or []
        names = {tool["function"]["name"] for tool in offered}
        if not offered:
            message: dict[str, Any] = {"role": "assistant", "content": "ok"}
        elif names == {"StructuredOutput"} and self.final is not None:
            # The only tool left is the return tool (the runner's wrap-up): a model answers with it.
            message = asks(tool_call("call_wrap_up", "StructuredOutput", self.final))
        else:
            index = sum(1 for earlier in self.requests[:-1] if earlier.get("tools"))
            if index < len(self.steps):
                step = self.steps[index]
                message = step(body) if callable(step) else step
            else:
                assert self.final is not None, "the script ran out of steps and has no final answer"
                message = asks(tool_call(f"call_final_{index}", "StructuredOutput", self.final))
        # A step may name the finish reason the provider reports (it defaults to what a provider
        # reports for the message); it is not part of the message.
        message = dict(message)
        finish = message.pop("finish_reason", None) or (
            "tool_calls" if message.get("tool_calls") else "stop"
        )
        usage: dict[str, Any] = {"prompt_tokens": 50, "completion_tokens": 10}
        if self.cost is not None:
            usage["cost"] = self.cost
        return {
            "id": "chatcmpl-test",
            "choices": [{"message": message, "finish_reason": finish}],
            "usage": usage,
        }

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "ScriptedModel":
        self._thread.start()
        return self

    def __exit__(self, *args: object) -> None:
        self._released.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)

    # -- what the engine showed the model ---------------------------------------

    def tool_results(self) -> dict[str, str]:
        """The result of every tool call, by call id, as the last request carried it."""
        last: dict[str, Any] | None = next(
            (r for r in reversed(self.requests) if r.get("tools")), None
        )
        results: dict[str, str] = {}
        messages: list[dict[str, Any]] = last["messages"] if last else []
        for message in messages:
            if message.get("role") == "tool":
                results[message["tool_call_id"]] = str(message.get("content"))
        return results

    def offered_tools(self) -> set[str]:
        first = next(r for r in self.requests if r.get("tools"))
        return {tool["function"]["name"] for tool in first["tools"]}


def dynamic_job(head_sha: str) -> Job:
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/196",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": "deepseek/deepseek-v4.1-flash",
                    "skill": "SKILL_TEXT_FROM_THE_PROJECT: look for real bugs.",
                    "limits": {"maxFindings": 5},
                },
                "base": {
                    "repository": "octo/repo",
                    "baseRef": "main",
                    "headSha": head_sha,
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
                    "apiKey": API_KEY,
                },
            }
        )
    )


def findings_for(head_sha: str, path: str = "src/app.py") -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "reviewedSha": head_sha,
        "resolvedIds": [],
        "findings": [
            {
                "id": "f-1",
                "priority": "P2",
                "confidence": 0.7,
                "title": "Unvalidated user value reaches the query",
                "body": "The value is passed on without validation.",
                "path": path,
                "lineStart": 1,
                "lineEnd": 2,
                "evidence": [f"{path}:1"],
                "reviewedSha": head_sha,
            }
        ],
    }


class RecordingAudit(ToolAudit):
    """The proxy's audit, which also keeps what the engine sent: the result texts before the
    proxy neutralised them (#232), so a test can tell what the engine really emits from what the
    model is shown."""

    def __init__(self, ledger: BudgetLedger) -> None:
        super().__init__(ledger)
        self.engine_sent: dict[str, str] = {}

    def results_in_request(self, messages: object) -> Any:
        history = messages
        if isinstance(messages, list):
            entries: list[Any] = messages  # pyright: ignore[reportUnknownVariableType]
            for item in entries:
                message = as_object(item)
                if message is not None and message.get("role") == "tool":
                    self.engine_sent.setdefault(
                        str(message.get("tool_call_id")), str(message.get("content"))
                    )
        return super().results_in_request(history)


@dataclass
class Run:
    answer: EngineAnswer
    ledger: BudgetLedger
    proxy: ModelProxy
    capability: str
    engine_sent: dict[str, str] = field(default_factory=lambda: {})


def run_engine(
    model: ScriptedModel,
    content: PreparedContent,
    *,
    scratch: Path,
    limits: DynamicLimits | None = None,
    export: Path | None = None,
    files: frozenset[str] | None = None,
    clock: Callable[[], float] | None = None,
) -> Run:
    """Run the real engine over a prepared export against the scripted model, through the proxy.

    `export` overrides the directory the engine is pointed at (the control run uses a raw tree).
    """
    ledger = BudgetLedger(
        limits or DynamicLimits(), unit_costs=UNIT_COSTS, clock=clock or time.monotonic
    )
    capability = new_proxy_capability()
    proxy = ModelProxy(
        ledger=ledger,
        base_path="/v1",
        model="deepseek/deepseek-v4.1-flash",
        upstream_url=f"{model.url}/v1/chat/completions",
        upstream_api_key=API_KEY,
        upstream_model="deepseek/deepseek-v4.1-flash",
        capabilities=capabilities_from_config(CAPABILITIES),
        capability=capability,
        provider=OPENROUTER,
    )
    audit = RecordingAudit(ledger)
    proxy.audit = audit
    directory = export or content.export
    proxy.audit.set_export_root(str(directory))
    job = dynamic_job(content.head_sha)
    dynamic = job.dynamic
    assert dynamic is not None
    server = proxy.serve("127.0.0.1").start()
    try:
        engine = DynamicEngine(
            job,
            ledger=ledger,
            command=[str(opencode_binary())],
            directory=str(directory),
            proxy_url=server.url,
            proxy_capability=capability,
            agent_prompt=compose_system_prompt(dynamic.skill, content.head_sha),
            model_schema=findings_schema(),
            inputs=review_inputs(job.pr_url, content),
            exported_paths=frozenset(content.files) if files is None else files,
            scratch_dir=str(scratch),
            node_bin=extra_path(),
            ripgrep=ripgrep_binary(),
            startup_seconds=60.0,
        )
        answer = engine.run()
    finally:
        server.stop()
    return Run(
        answer=answer,
        ledger=ledger,
        proxy=proxy,
        capability=capability,
        engine_sent=audit.engine_sent,
    )
