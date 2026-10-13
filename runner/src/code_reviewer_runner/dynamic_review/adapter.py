# SPDX-License-Identifier: Apache-2.0

"""The stock-engine adapter of one Dynamic Review (#197).

One headless engine server per job, driven through the pinned local HTTP API (see the merged #85
write-up). The engine is stock: this module never patches it, never installs a plugin and never
reads its internals. The trusted configuration it writes (`config.py`), the model proxy it points
the engine at (`proxy.py`) and the ledger it shares with both (`budget.py`) are the whole boundary.

The order is deliberate and mirrors the epic's:

1. the model proxy is up and its destination proven capable **before** the engine starts;
2. the runner writes the trusted config (with the fixed core as the agent's prompt, so it reaches
   the model through the trusted channel, not through repository instructions) and starts the
   engine with a minimal, closed environment;
3. the adapter waits for a healthy pinned server, then opens one session;
4. the untrusted input is sent as one structured turn; the reviewed head comes from the validated
   claim (`base.head_sha`), never from repository content;
5. the tool, file and result-byte bounds are audited **at the proxy** from the model requests
   themselves (`audit.py`), not read back from the engine's session afterwards: the pinned server
   cannot even list a session that has a stored JSON-schema format (#85, a 400), and a count taken
   after the fact would not be preventive anyway. The adapter only reads the stable cause the proxy
   recorded in the ledger, and validates the structured answer with the typed findings parser
   against the files the export really contains;
6. any limit, any engine exit and any unusable answer ends the run with a stable code, at the moment
   it happens (the run does not wait for the engine to give up); the whole owned process group is
   stopped and its private scratch directory removed. No fallback, no partial success.

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
import threading
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request

from code_reviewer_runner.dynamic_findings import (
    DynamicFindings,
    FindingsError,
    parse_dynamic_findings,
)
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, LimitError
from code_reviewer_runner.dynamic_review.config import (
    PROXY_PROVIDER_ID,
    build_engine_config,
    engine_environment,
)
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.net import no_redirect_opener
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs, compose_user_prompt
from code_reviewer_runner.dynamic_review.schema import engine_schema
from code_reviewer_runner.job import Job
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.process_group import end_group, has_exited
from code_reviewer_runner.result import ErrorCode

# The engine's own report of its version; the adapter refuses anything else.
PINNED_ENGINE_VERSION = "1.19.0"
# How long the engine may take to print its listening marker and answer a health check.
STARTUP_SECONDS = 20.0
# How often a start is attempted on a fresh port when the engine could not bind the one picked.
START_ATTEMPTS = 3
# How long one message may take before the adapter ends the run (the whole-job deadline binds
# first when it is shorter).
MESSAGE_TIMEOUT_SECONDS = 300.0
# One health check or session request. Before the listening marker the pinned server can accept a
# connection and never answer, so a poll must give up quickly and try again.
SHORT_TIMEOUT_SECONDS = 2.0
SESSION_TIMEOUT_SECONDS = 30.0
# How often the run checks the ledger, the deadline and the engine process while a message runs.
WATCH_INTERVAL_SECONDS = 0.05
# The agent the runner defines and selects; the request may never name another.
REVIEW_AGENT = "review"
# The largest startup/answer body the adapter will read before the ledger refuses it.
CLIENT_MAX_BYTES = 8 * 1024 * 1024
SESSION_TITLE = "code-reviewer-read-only-review"

# The process groups of the engines this process started. An engine leads its own group (so ending
# one job's engine never ends the runner), but then it must be ended explicitly: this registry is
# what the entry point's watchdog kills when the job process itself has to exit (#197-T07).
# A group id is only in the registry while its leader is not reaped (process_group.py), so the id
# cannot have been given to an unrelated group; the lock keeps the watchdog thread from signalling
# an id while it is taken off the registry.
_RUNNING_ENGINES: set[int] = set()
# The dedicated users whose engines run, so the watchdog also ends what left the process group.
_RUNNING_LAUNCHES: list[EngineLaunch] = []
_ENGINES_LOCK = threading.Lock()


def shutdown_engines() -> None:
    """End every engine this process started, groups and users. Safe to call twice or with none."""
    with _ENGINES_LOCK:
        for pgid in list(_RUNNING_ENGINES):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(pgid, signal.SIGKILL)
        _RUNNING_ENGINES.clear()
        launches = list(_RUNNING_LAUNCHES)
        _RUNNING_LAUNCHES.clear()
    # Whatever the dedicated user still runs (a helper in a session of its own) goes too, and its
    # network rules with it.
    for launch in launches:
        launch.close()


class EngineError(Exception):
    """The engine could not run or did not answer. `code` is stable; `detail` names no value."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


class EngineExited(EngineError):
    """The engine process ended while it was being waited for."""

    def __init__(self) -> None:
        super().__init__(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine exited during startup")


@dataclass(frozen=True)
class EngineAnswer:
    """What one run produced: findings on success, a stable error otherwise. Never both."""

    findings: DynamicFindings | None
    error: EngineError | None

    @property
    def ok(self) -> bool:
        return self.findings is not None and self.error is None


# The transport of the client: method, URL, body (bytes), headers, timeout -> (status, body bytes).
# A test replaces it to script answers; the real one talks to the engine on loopback.
Transport = Callable[[str, str, bytes | None, Mapping[str, str], float], tuple[int, bytes]]


def _http_request(
    method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
) -> tuple[int, bytes]:
    request = Request(url, data=body, method=method, headers=dict(headers))
    try:
        # Loopback only: never through a proxy of the environment, never through a redirect.
        opener = no_redirect_opener(direct=True)
        with opener.open(request, timeout=timeout) as response:
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

    def _call(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        scoped: bool = True,
        timeout: float = MESSAGE_TIMEOUT_SECONDS,
    ) -> tuple[int, bytes]:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        # Scope every session request to the prepared export. The engine may read nowhere else; a
        # directory the request names is ignored, this header is the runner's. The health check is
        # global and carries none.
        if scoped:
            headers["x-opencode-directory"] = self.directory
        return self._transport(method, f"{self.base_url}{path}", payload, headers, timeout)

    def health(self) -> bool:
        """True when the server answers a healthy pinned-version health check."""
        try:
            status, body = self._call(
                "GET", "/global/health", scoped=False, timeout=SHORT_TIMEOUT_SECONDS
            )
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

    def wait_healthy(
        self, deadline_seconds: float, alive: Callable[[], bool] = lambda: True
    ) -> None:
        """Poll until healthy; a healthy server is the listening marker #85 verified.

        `alive` tells whether the engine process we started is still running. An answer only counts
        while it is: if our process died (for example it could not bind a port a stranger took in
        the meantime), whatever answers on that port is not our engine.
        """
        until = time.monotonic() + deadline_seconds
        while time.monotonic() < until:
            if not alive():
                raise EngineExited()
            if self.health() and alive():
                return
            time.sleep(0.2)
        raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not become healthy")

    def create_session(self) -> str:
        status, body = self._call(
            "POST", "/session", {"title": SESSION_TITLE}, timeout=SESSION_TIMEOUT_SECONDS
        )
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
        self,
        session_id: str,
        *,
        model: str,
        parts: list[dict[str, str]],
        schema: Any,
        timeout: float = MESSAGE_TIMEOUT_SECONDS,
    ) -> None:
        """Send one structured turn to the runner-defined review agent."""
        body = {
            "agent": REVIEW_AGENT,
            "model": {"providerID": PROXY_PROVIDER_ID, "modelID": model},
            "format": {"type": "json_schema", "schema": schema},
            "parts": parts,
        }
        status, answer = self._call("POST", f"/session/{session_id}/message", body, timeout=timeout)
        if status != 200:
            raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine did not answer")
        self.last_message = answer

    def abort(self, session_id: str) -> None:
        try:
            self._call("POST", f"/session/{session_id}/abort", timeout=SHORT_TIMEOUT_SECONDS)
        except EngineError:
            return  # the process group is ended anyway


def structured_answer(message: bytes) -> Any:
    """The structured result out of a message POST answer, or None.

    The pinned server answers `{info, parts}`: a valid JSON-schema answer is stored in
    `info.structured` (the real shape, checked against the binary), and a model that answered in
    prose leaves its JSON in a `text` part. The runner-side codec accepts either and never trusts
    it without the typed validation that follows; `info.error` (for example a missing structured
    answer) is not an answer.
    """
    try:
        value: Any = json.loads(message)
    except ValueError:
        return None
    document = as_object(value)
    if document is None:
        return None
    info = as_object(document.get("info"))
    structured: Any = info.get("structured") if info else None
    if structured is not None:
        return structured
    if info is not None and info.get("error") is not None:
        return None
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
        inputs: ReviewInputs,
        exported_paths: Collection[str] | None,
        scratch_dir: str | None = None,
        launch: EngineLaunch | None = None,
        node_bin: str | None = None,
        require_ripgrep: bool = True,
        startup_seconds: float = STARTUP_SECONDS,
        transport: Transport = _http_request,
        port_source: Callable[[], int] = lambda: _free_port(),
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
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
        # What the model is given (the real title, body and diff of #196) and the files a finding
        # may point at (exactly the verified export). Both come from the trusted preparation.
        self.inputs = inputs
        self.exported_paths = exported_paths
        self.node_bin = node_bin
        self.require_ripgrep = require_ripgrep
        self.startup_seconds = startup_seconds
        self._transport = transport
        self._port_source = port_source
        self._popen = popen
        # Set by the supervisor: the engine then runs as the dedicated user with its own network
        # rules, and its home, temporary files and config live where `export_isolation` prepared
        # them (removed with the job's lifetime). Without it (the unprivileged engine suite and
        # the scripted tests) the engine runs as the current user in a private scratch directory.
        self.launch = launch
        # The export is read-only and belongs to the engine user; the runner's own config, home and
        # cache live in a private directory outside it, removed when the run ends.
        self._scratch = (
            Path(scratch_dir)
            if scratch_dir
            else Path(launch.tmpdir)
            if launch
            else Path(tempfile.mkdtemp(prefix="cr-engine-"))
        )
        self._process: subprocess.Popen[bytes] | None = None
        self._worker: threading.Thread | None = None

    # -- process --------------------------------------------------------------

    def start(self) -> EngineClient:
        """Write the trusted config, start the engine and wait for it to become healthy."""
        dynamic = self.job.dynamic
        assert dynamic is not None  # narrowed in __init__
        config = build_engine_config(
            proxy_url=self.proxy_url,
            model=dynamic.model,
            system_prompt=self.agent_prompt,
            proxy_capability=self._proxy_capability,
        )
        if self.launch is not None:
            # The dedicated user's own directories exist and are its own; the config is its file.
            config_path = self.launch.write_config(config)
            home = self.launch.home
        else:
            self._scratch.mkdir(parents=True, exist_ok=True)
            os.chmod(self._scratch, 0o700)
            (self._scratch / "home").mkdir(parents=True, exist_ok=True)
            config_path = self._scratch / "opencode.json"
            # The config carries the job's proxy capability: owner-only, in the private scratch.
            descriptor = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(config))
            home = str(self._scratch / "home")
        environment = engine_environment(
            proxy_url=self.proxy_url,
            home=home,
            scratch_dir=str(self._scratch),
            node_bin=self.node_bin,
        )
        # The one file the engine reads its configuration from (confirmed against the pinned
        # release). `OPENCODE_CONFIG_DIR` is deliberately not set: a config directory makes the
        # engine install `@opencode-ai/plugin` into it from the package registry, a download and
        # an install the runner must never allow.
        environment["OPENCODE_CONFIG"] = str(config_path)
        # The engine's grep and glob run ripgrep. Without one on its PATH the pinned release
        # downloads a binary from GitHub on first use (seen against the real binary): a runtime
        # download the runner never allows, and one that fails anyway without network. The trusted
        # image supplies `rg`; a missing one is a refusal to start, not an attempt to fetch it.
        if self.require_ripgrep and shutil.which("rg", path=environment["PATH"]) is None:
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "no ripgrep on the engine search path"
            )
        # The port is only probed free, not held: the engine binds it itself a moment later. If a
        # stranger took it in between, our engine exits instead of serving and is started again on
        # another port; an answer is only trusted while our own process is alive.
        for attempt in range(START_ATTEMPTS):
            port = self._port_source()
            if self.launch is not None:
                # The user's network is closed to everything but this job's proxy (and the
                # engine's own server) before the engine exists, and proven once.
                self.launch.confine(_port_of(self.proxy_url), port)
            self._spawn(environment, port)
            client = EngineClient(
                f"http://127.0.0.1:{port}", self.directory, transport=self._transport
            )
            try:
                client.wait_healthy(self.startup_seconds, self._is_running)
                self._require_own_listener(port)
            except EngineExited:
                self._end_process()
                if attempt + 1 == START_ATTEMPTS:
                    raise
                continue
            except EngineError:
                self.stop()
                raise
            return client
        raise EngineExited()  # unreachable: the last attempt raises

    def _require_own_listener(self, port: int) -> None:
        """The answer came from our engine: its user, and nobody else, listens on that port."""
        if self.launch is None or self.launch.owns_listener(port):
            return
        raise EngineError(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine port is not held by the engine user"
        )

    def _spawn(self, environment: dict[str, str], port: int) -> None:
        argv = [
            *self.command,
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            str(port),
            "--print-logs",
        ]
        options: dict[str, Any] = self.launch.spawn_options() if self.launch else {}
        try:
            process = self._popen(
                argv,
                env=environment,
                cwd=self.directory,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                **options,
            )
        except OSError:
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine could not be started"
            ) from None
        self._process = process
        with _ENGINES_LOCK:
            _RUNNING_ENGINES.add(process.pid)
            if self.launch is not None and self.launch not in _RUNNING_LAUNCHES:
                _RUNNING_LAUNCHES.append(self.launch)

    def _is_running(self) -> bool:
        # Looking must not reap the engine: while its group is alive its id has to stay ours.
        return self._process is not None and not has_exited(self._process)

    def stop(self) -> None:
        """End the whole owned process group, then the user's leftovers, and the private scratch.

        With a dedicated user the scratch belongs to the job's lifetime (`export_isolation`
        removes it); here only what the user still runs and its network rules end.
        """
        self._end_process()
        if self.launch is not None:
            with _ENGINES_LOCK:
                if self.launch in _RUNNING_LAUNCHES:
                    _RUNNING_LAUNCHES.remove(self.launch)
            self.launch.close()
        else:
            shutil.rmtree(self._scratch, ignore_errors=True)

    def _end_process(self) -> None:
        process = self._process
        if process is not None:
            # The engine leads its own session, so its pid is its process group id. Off the registry
            # first (the watchdog then leaves it to us), then the group is ended and the leader
            # reaped last, so the id is never signalled after it could belong to somebody else.
            with _ENGINES_LOCK:
                _RUNNING_ENGINES.discard(process.pid)
            end_group(process)
            if self.launch is not None:
                # A helper that left the group is still the dedicated user's process.
                self.launch.sweep()
        self._process = None

    # -- run ------------------------------------------------------------------

    def run(self) -> EngineAnswer:
        """Run one review. Never raises; a failure is a stable code with no partial result."""
        try:
            self.ledger.check_deadline()
            client = self.start()
            session_id = client.create_session()
            try:
                self._send(client, session_id)
                self._raise_recorded_failure()
                return self._validate(client)
            finally:
                client.abort(session_id)
        except LimitError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except EngineError as error:
            return EngineAnswer(findings=None, error=error)
        except IsolationError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except FindingsError as error:
            return EngineAnswer(findings=None, error=EngineError(error.code, error.detail))
        except OSError:
            return EngineAnswer(
                findings=None,
                error=EngineError(ErrorCode.RUNNER_ERROR, "the engine could not be run"),
            )
        finally:
            self.stop()
            if self._worker is not None:
                self._worker.join(timeout=5.0)

    def _raise_recorded_failure(self) -> None:
        """A limit or provider refusal the proxy recorded is the run's result."""
        failure = self.ledger.failure
        if failure is not None:
            raise failure

    def _send(self, client: EngineClient, session_id: str) -> None:
        dynamic = self.job.dynamic
        assert dynamic is not None
        # The fixed core, the verified head and the skill are the agent's prompt in the trusted
        # config; only the delimited untrusted input travels as a message part.
        prompt = compose_user_prompt(self.inputs)
        self.ledger.check_input_bytes(len(prompt.encode("utf-8")))
        schema = engine_schema(self.model_schema, dynamic.limits.max_findings)
        outcome: list[Exception] = []
        finished = threading.Event()

        def post() -> None:
            try:
                client.send_message(
                    session_id,
                    model=dynamic.model,
                    parts=[{"type": "text", "text": prompt}],
                    schema=schema,
                    timeout=max(min(MESSAGE_TIMEOUT_SECONDS, self.ledger.remaining_seconds()), 1.0),
                )
            except Exception as error:  # re-raised below, in the caller's thread
                outcome.append(error)
            finally:
                finished.set()

        # The message call blocks until the engine is done. It runs beside a watch that ends the
        # run the moment the proxy records a limit or a provider refusal, the deadline passes or
        # the engine dies, instead of waiting for an engine that is retrying a refused call.
        self._worker = threading.Thread(target=post, daemon=True)
        self._worker.start()
        while not finished.wait(WATCH_INTERVAL_SECONDS):
            self._raise_recorded_failure()
            self.ledger.check_deadline()
            if not self._is_running():
                raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, "the engine exited")
        self._raise_recorded_failure()
        if outcome:
            # A call that ran into its timeout at the whole-job deadline is the deadline, not an
            # unreachable engine: both end at the same moment and the order must not matter.
            self.ledger.check_deadline()
            raise outcome[0]

    def _validate(self, client: EngineClient) -> EngineAnswer:
        base = self.job.base
        dynamic = self.job.dynamic
        assert base is not None and dynamic is not None
        raw = structured_answer(client.last_message)
        if raw is None:
            return EngineAnswer(
                findings=None,
                error=EngineError(
                    ErrorCode.LLM_OUTPUT_INVALID, "the engine returned no structured answer"
                ),
            )
        # A finding may only point at a file the verified export really contains.
        findings = parse_dynamic_findings(raw, exported_paths=self.exported_paths)
        if len(findings.findings) > dynamic.limits.max_findings:
            raise LimitError(
                ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                "the answer has more findings than the job allows",
            )
        if findings.reviewed_sha != base.head_sha:
            raise FindingsError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION,
                "the answer was made against another reviewed head",
            )
        return EngineAnswer(findings=findings, error=None)


def _port_of(url: str) -> int:
    """The port of an `http://127.0.0.1:<port>` address the runner itself built."""
    return int(url.rsplit(":", 1)[-1].split("/", 1)[0])


def _free_port() -> int:
    """A free loopback port for one job's engine. Private to the job; never a fixed port."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
