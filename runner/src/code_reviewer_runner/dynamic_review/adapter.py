# SPDX-License-Identifier: Apache-2.0

"""The stock-engine adapter of one Dynamic Review (#197).

One headless engine server per job, driven through the pinned local HTTP API (see the merged #85
write-up). The engine is stock: this module never patches it, never installs a plugin and never
reads its internals. The trusted configuration it writes (`config.py`), the model proxy it points
the engine at (`proxy.py`) and the ledger it shares with both (`limits.py`) are the whole boundary.

The order is deliberate and mirrors the epic's:

1. the model proxy is up and its destination proven capable **before** the engine starts;
2. the runner writes the trusted config (with the fixed core as the agent's prompt, so it reaches
   the model through the trusted channel, not through repository instructions) and starts the
   engine with a minimal, closed environment;
3. the adapter waits for a healthy pinned server, then opens one session;
4. the untrusted input is sent as one structured turn; the reviewed head comes from the validated
   claim (`base.head_sha`), never from repository content;
5. the tool parts the engine reports are counted against the ledger (tools, files, result bytes) and
   the structured answer is validated with the typed findings parser;
6. any limit, any engine exit and any unusable answer ends the run with a stable code; the whole
   owned process group is stopped and its private scratch directory removed. No fallback, no partial
   success.

`steps`, SSE events and the engine's own counters are observation only; nothing here trusts them.
"""

import contextlib
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from code_reviewer_runner.dynamic_findings import (
    DynamicFindings,
    FindingsError,
    parse_dynamic_findings,
)
from code_reviewer_runner.dynamic_review.config import build_engine_config, engine_environment
from code_reviewer_runner.dynamic_review.limits import BudgetLedger, LimitError
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs, compose_user_prompt
from code_reviewer_runner.job import Job
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

# The engine's own report of its version; the adapter refuses anything else.
PINNED_ENGINE_VERSION = "1.19.0"
# How long the engine may take to print its listening marker and answer a health check.
STARTUP_SECONDS = 20.0
# How long one message may take before the adapter ends the run.
MESSAGE_TIMEOUT_SECONDS = 300.0
# The agent the runner defines and selects; the request may never name another.
REVIEW_AGENT = "review"
# The largest startup/answer body the adapter will read before the ledger refuses it.
CLIENT_MAX_BYTES = 8 * 1024 * 1024
SESSION_TITLE = "code-reviewer-read-only-review"

# The process groups of the engines this process started. An engine leads its own group (so ending
# one job's engine never ends the runner), but then it must be ended explicitly: this registry is
# what the entry point's watchdog kills when the job process itself has to exit (#197-T07).
_RUNNING_ENGINES: set[int] = set()


def shutdown_engines() -> None:
    """End every engine process group this process started. Safe to call twice or with none."""
    for pgid in list(_RUNNING_ENGINES):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pgid, signal.SIGKILL)
    _RUNNING_ENGINES.clear()


class EngineError(Exception):
    """The engine could not run or did not answer. `code` is stable; `detail` names no value."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class EngineAnswer:
    """What one run produced: findings on success, a stable error otherwise. Never both."""

    findings: DynamicFindings | None
    error: EngineError | None

    @property
    def ok(self) -> bool:
        return self.findings is not None and self.error is None


# The transport of the client: method, URL, body (bytes), headers -> (status, body bytes). A test
# replaces it to script answers; the real one talks to the engine on loopback.
Transport = Callable[[str, str, bytes | None, Mapping[str, str]], tuple[int, bytes]]


def _http_request(
    method: str, url: str, body: bytes | None, headers: Mapping[str, str]
) -> tuple[int, bytes]:
    request = Request(url, data=body, method=method, headers=dict(headers))
    try:
        with urlopen(request, timeout=MESSAGE_TIMEOUT_SECONDS) as response:
            return response.status, response.read(CLIENT_MAX_BYTES)
    except HTTPError as error:
        return error.code, error.read(CLIENT_MAX_BYTES)
    except (URLError, TimeoutError, ConnectionError, OSError):
        raise EngineError(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine is not reachable"
        ) from None


class EngineClient:
    """The verified HTTP surface of one engine server. Only the endpoints the run needs."""

    def __init__(
        self, base_url: str, directory: str, *, transport: Transport = _http_request
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.directory = directory
        self.last_message: bytes = b""
        self._transport = transport

    def _call(self, method: str, path: str, body: Any = None) -> tuple[int, bytes]:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        # Scope every request to the prepared export. The engine may read nowhere else; a directory
        # the request names is ignored, this header is the runner's.
        headers["x-opencode-directory"] = self.directory
        return self._transport(method, f"{self.base_url}{path}", payload, headers)

    def health(self) -> bool:
        """True when the server answers a healthy pinned-version health check."""
        try:
            status, body = self._call("GET", "/global/health")
        except EngineError:
            return False
        if status != 200:
            return False
        try:
            value: Any = json.loads(body)
        except ValueError:
            return False
        document = as_object(value)
        if document is None:
            return False
        return document.get("healthy") is True and document.get("version") == PINNED_ENGINE_VERSION

    def wait_healthy(self, deadline_seconds: float) -> None:
        """Poll until healthy; a healthy server is the listening marker #85 verified."""
        until = time.monotonic() + deadline_seconds
        while time.monotonic() < until:
            if self.health():
                return
            time.sleep(0.2)
        raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not become healthy")

    def create_session(self) -> str:
        status, body = self._call("POST", "/session", {"title": SESSION_TITLE})
        if status != 200:
            raise EngineError(ErrorCode.RUNNER_ERROR, "the engine refused a new session")
        session_id: Any = None
        try:
            value: Any = json.loads(body)
        except ValueError:
            session_id = None
        else:
            document = as_object(value)
            session_id = None if document is None else document.get("id")
        if not isinstance(session_id, str) or not session_id:
            raise EngineError(ErrorCode.RUNNER_ERROR, "the engine returned no session id")
        return session_id

    def send_message(
        self, session_id: str, *, model: str, parts: list[dict[str, str]], schema: Any
    ) -> None:
        """Send one structured turn to the runner-defined review agent."""
        body = {
            "agent": REVIEW_AGENT,
            "model": {"providerID": "review-proxy", "modelID": model},
            "format": {"type": "json_schema", "schema": schema},
            "parts": parts,
        }
        status, answer = self._call("POST", f"/session/{session_id}/message", body)
        if status != 200:
            raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not answer")
        self.last_message = answer

    def messages(self, session_id: str) -> list[dict[str, Any]]:
        """The session's messages, for the tool parts the ledger counts.

        The pinned server has a known structured-message codec defect (#85): the list may answer
        400. The structured answer already arrived on the message POST, so a broken list is
        tolerated; it is never replaced by an invented empty answer.
        """
        status, body = self._call("GET", f"/session/{session_id}/message")
        if status != 200:
            return []
        try:
            value: Any = json.loads(body)
        except ValueError:
            return []
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, dict)]  # type: ignore[misc]

    def abort(self, session_id: str) -> None:
        try:
            self._call("POST", f"/session/{session_id}/abort")
        except EngineError:
            return  # the process group is ended anyway


def structured_answer(message: bytes) -> Any:
    """The structured result out of a message POST answer, or None.

    The pinned server stores a valid JSON-schema answer in the assistant message's `structured`
    field; the spike also saw the JSON in a `text` part. The runner-side codec accepts either and
    never trusts it without the typed validation that follows.
    """
    try:
        value: Any = json.loads(message)
    except ValueError:
        return None
    document = as_object(value)
    if document is None:
        return None
    structured: Any = document.get("structured")
    if structured is not None:
        return structured
    parts: Any = document.get("parts")
    if not isinstance(parts, list):
        return None
    entries: list[Any] = parts  # pyright: ignore[reportUnknownVariableType]
    for part in entries:
        block = as_object(part)
        if block is None or block.get("type") != "text":
            continue
        text: Any = block.get("text")
        if isinstance(text, str):
            return text
    return None


class DynamicEngine:
    """One Dynamic Review: the proxy is running, the engine is started, everything is counted."""

    def __init__(
        self,
        job: Job,
        *,
        ledger: BudgetLedger,
        command: Sequence[str],
        directory: str,
        proxy_url: str,
        proxy_capability: str,
        agent_prompt: str,
        model_schema: dict[str, Any],
        scratch_dir: str | None = None,
        node_bin: str | None = None,
        startup_seconds: float = STARTUP_SECONDS,
        transport: Transport = _http_request,
    ) -> None:
        if job.dynamic is None or job.base is None:
            raise EngineError(
                ErrorCode.DYNAMIC_CONFIG_INVALID, "the job carries no dynamic options"
            )
        self.job = job
        self.ledger = ledger
        self.command = tuple(command)
        self.directory = directory
        self.proxy_url = proxy_url
        self._proxy_capability = proxy_capability
        self.agent_prompt = agent_prompt
        self.model_schema = model_schema
        self.node_bin = node_bin
        self.startup_seconds = startup_seconds
        self._transport = transport
        # The export is read-only and belongs to the engine user; the runner's own config, home and
        # cache live in a private directory outside it, removed when the run ends.
        self._scratch = (
            Path(scratch_dir) if scratch_dir else Path(tempfile.mkdtemp(prefix="cr-engine-"))
        )
        self._process: subprocess.Popen[bytes] | None = None
        self._counted_tool_calls: set[str] = set()

    # -- process --------------------------------------------------------------

    def start(self) -> EngineClient:
        """Write the trusted config, start the engine and wait for it to become healthy."""
        dynamic = self.job.dynamic
        assert dynamic is not None  # narrowed in __init__
        self._scratch.mkdir(parents=True, exist_ok=True)
        (self._scratch / "home").mkdir(parents=True, exist_ok=True)
        config = build_engine_config(
            proxy_url=self.proxy_url,
            model=dynamic.model,
            system_prompt=self.agent_prompt,
            proxy_capability=self._proxy_capability,
        )
        config_path = self._scratch / "opencode.json"
        # The config carries the job's proxy capability: owner-only, in the private scratch.
        descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(config))
        environment = engine_environment(
            proxy_url=self.proxy_url,
            home=str(self._scratch / "home"),
            scratch_dir=str(self._scratch),
            node_bin=self.node_bin,
        )
        # The one file the engine may read its configuration from. #202 confirms the exact variable
        # against the pinned release; the config directory is the private job scratch either way.
        environment["OPENCODE_CONFIG"] = str(config_path)
        environment["OPENCODE_CONFIG_DIR"] = str(self._scratch)
        port = _free_port()
        argv = [
            *self.command,
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            str(port),
            "--print-logs",
        ]
        try:
            process = subprocess.Popen(
                argv,
                env=environment,
                cwd=self.directory,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError:
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine could not be started"
            ) from None
        self._process = process
        _RUNNING_ENGINES.add(os.getpgid(process.pid))
        client = EngineClient(f"http://127.0.0.1:{port}", self.directory, transport=self._transport)
        try:
            client.wait_healthy(self.startup_seconds)
        except EngineError:
            self.stop()
            raise
        return client

    def _kill_group(self, sig: int) -> None:
        process = self._process
        if process is None:
            return
        try:
            os.killpg(os.getpgid(process.pid), sig)
        except (ProcessLookupError, PermissionError):
            return

    def stop(self) -> None:
        """End the whole owned process group and remove the private scratch directory."""
        process = self._process
        if process is not None:
            try:
                pgid = os.getpgid(process.pid)
            except ProcessLookupError:
                pgid = None
            if pgid is not None:
                _RUNNING_ENGINES.discard(pgid)
            self._kill_group(signal.SIGTERM)
            try:
                process.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                self._kill_group(signal.SIGKILL)
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=5.0)
            # A helper the engine started that ignored SIGTERM goes too: the group is ours.
            self._kill_group(signal.SIGKILL)
        self._process = None
        shutil.rmtree(self._scratch, ignore_errors=True)

    # -- run ------------------------------------------------------------------

    def run(self) -> EngineAnswer:
        """Run one review. Never raises; a failure is a stable code with no partial result."""
        try:
            self.ledger.check_deadline()
            client = self.start()
            session_id = client.create_session()
            try:
                self._send(client, session_id)
                self._count_tool_parts(client, session_id)
                return self._validate(client)
            finally:
                client.abort(session_id)
        except LimitError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except EngineError as error:
            return EngineAnswer(findings=None, error=error)
        except FindingsError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except OSError:
            return EngineAnswer(
                findings=None,
                error=EngineError(ErrorCode.RUNNER_ERROR, "the engine could not be run"),
            )
        finally:
            self.stop()

    def _send(self, client: EngineClient, session_id: str) -> None:
        dynamic = self.job.dynamic
        base = self.job.base
        assert dynamic is not None and base is not None
        inputs = ReviewInputs(
            pr_url=self.job.pr_url,
            pr_title="",
            pr_body="",
            diff="",
            comparison=base.comparison,
        )
        # The fixed core, the verified head and the skill are the agent's prompt in the trusted
        # config; only the delimited untrusted input travels as a message part.
        client.send_message(
            session_id,
            model=dynamic.model,
            parts=[{"type": "text", "text": compose_user_prompt(inputs)}],
            schema=self.model_schema,
        )

    def _count_tool_parts(self, client: EngineClient, session_id: str) -> None:
        for message in client.messages(session_id):
            parts: Any = message.get("parts")
            if not isinstance(parts, list):
                continue
            for part in parts:  # pyright: ignore[reportUnknownVariableType]
                self._count_part(part)

    def _count_part(self, part: Any) -> None:
        block = as_object(part)
        if block is None or block.get("type") != "tool":
            return
        call_id: Any = block.get("callID") or block.get("id")
        if isinstance(call_id, str):
            if call_id in self._counted_tool_calls:
                return
            self._counted_tool_calls.add(call_id)
        name: Any = block.get("tool")
        self.ledger.count_tool_call(name if isinstance(name, str) else "")
        state = as_object(block.get("state"))
        if state is None:
            return
        path = _tool_path(state.get("input"))
        if path is not None:
            self.ledger.count_file(path)
        output: Any = state.get("output")
        if isinstance(output, str):
            self.ledger.add_result_bytes(len(output.encode("utf-8")))
        metadata: Any = state.get("metadata")
        if metadata is not None:
            self.ledger.add_result_bytes(len(json.dumps(metadata).encode("utf-8")))

    def _validate(self, client: EngineClient) -> EngineAnswer:
        base = self.job.base
        assert base is not None
        raw = structured_answer(client.last_message)
        if raw is None:
            return EngineAnswer(
                findings=None,
                error=EngineError(
                    ErrorCode.LLM_OUTPUT_INVALID, "the engine returned no structured answer"
                ),
            )
        findings = parse_dynamic_findings(raw)
        if findings.reviewed_sha != base.head_sha:
            raise FindingsError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION,
                "the answer was made against another reviewed head",
            )
        return EngineAnswer(findings=findings, error=None)


def _tool_path(raw: Any) -> str | None:
    value = as_object(raw)
    if value is None:
        return None
    found: Any = value.get("filePath") or value.get("path") or value.get("pattern")
    return found if isinstance(found, str) and found else None


def _free_port() -> int:
    """A free loopback port for one job's engine. Private to the job; never a fixed port."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
