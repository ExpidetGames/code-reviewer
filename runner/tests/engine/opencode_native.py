# SPDX-License-Identifier: Apache-2.0

"""Support for the engine tests of the native provider path (#546, study #544).

It starts the real, pinned OpenCode (`opencode_support.opencode_binary()`) the way the adapter does
(`serve` on a loopback port, the closed environment of `config.engine_environment`, default-deny
permissions, one agent), but with a provider entry of the test's choosing instead of the runner's
model proxy: the entry the study proposes to generate per job (`provider.<id>` with `npm`,
`options.baseURL` and `options.apiKey` and `models.<model>`), pointing at the key swapping relay of
`fakes/wire/relay.py`, which points at the scripted upstream of `fakes/wire/upstream.py`.

Nothing here is production code and nothing talks beyond loopback. The turn it sends has no
`format`, so the engine runs its ordinary tool loop and ends in plain text (decision 4 of #544).
"""

import contextlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from opencode_support import extra_path, opencode_binary, ripgrep_binary

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Family, Turn
from fakes.wire.relay import KeySwapRelay
from fakes.wire.upstream import Judge, OnAnswer, ScriptedUpstream

from code_reviewer_runner.dynamic_review.config import engine_environment, permission_block

REAL_KEY = "real-key-stand-in-0123456789"
DUMMY_KEY = "dummy-capability-0123456789"

# A provider id and a model id that the embedded snapshot of the pinned engine has never heard of.
DEFAULT_IDS: dict[Family, tuple[str, str]] = {
    "chat": ("acme-chat", "acme-chat-9"),
    "responses": ("acme-resp", "acme-resp-9"),
    "messages": ("acme-claude", "acme-claude-9"),
    "google": ("acme-gemini", "acme-gemini-9"),
}
# The AI SDK package of a family and the base path the SDK appends its route to.
NPM: dict[Family, str] = {
    "chat": "@ai-sdk/openai-compatible",
    "responses": "@ai-sdk/openai",
    "messages": "@ai-sdk/anthropic",
    "google": "@ai-sdk/google",
}
BASE_PATH: dict[Family, str] = {
    "chat": "/v1",
    "responses": "/v1",
    "messages": "/v1",
    "google": "/v1beta",
}
# The smallest model entry that states what the study proposes to generate: limits and capabilities.
MINIMAL_ENTRY: dict[str, Any] = {
    "name": "Spike model",
    "limit": {"context": 200000, "output": 8192},
    "tool_call": True,
    "reasoning": False,
    "temperature": True,
}
SESSION_TITLE = "spike"
TURN_SECONDS = 120.0


@dataclass
class Assistant:
    """One assistant message of the session: what the engine counted and what it did."""

    tokens: dict[str, Any]
    cost: float
    finish: str | None
    error: dict[str, Any] | None
    tools: list[str]
    text: str


@dataclass
class NativeRun:
    family: Family
    upstream: ScriptedUpstream
    relay: KeySwapRelay
    http_status: int
    reply: Any
    assistants: list[Assistant]
    resolved: dict[str, Any]
    log: str
    scratch: Path = field(default_factory=Path)


def tool_script(export: Path, steps: int, thinking: str = "") -> list[Turn]:
    """Up to six tool calls over the little export, then the final text."""
    plan = [
        Turn(tool="glob", args={"pattern": "**/*.py"}, thinking=thinking),
        Turn(tool="read", args={"filePath": str(export / "src" / "app.py")}, thinking=thinking),
        Turn(tool="grep", args={"pattern": "def "}, thinking=thinking),
        Turn(tool="read", args={"filePath": str(export / "src" / "db.py")}, thinking=thinking),
        Turn(tool="glob", args={"pattern": "*.md"}, thinking=thinking),
        Turn(tool="grep", args={"pattern": "query"}, thinking=thinking),
    ][:steps]
    return [*plan, Turn(text='{"findings": [], "summary": "spike done"}', thinking=thinking)]


def make_export(root: Path) -> Path:
    export = root / "export"
    (export / "src").mkdir(parents=True)
    (export / "src" / "app.py").write_text("def handler(user):\n    return query(user)\n")
    (export / "src" / "db.py").write_text("def query(value):\n    return 'SELECT ' + value\n")
    (export / "README.md").write_text("# demo\n")
    return export


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _call(
    method: str, url: str, body: Any, directory: str | None, timeout: float = 30.0
) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if directory:
        headers["x-opencode-directory"] = directory
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, raw.decode("utf-8", "replace")


def provider_entry(
    family: Family, relay_url: str, model: str, *, entry: Mapping[str, Any] | None, npm: bool
) -> dict[str, Any]:
    """The `provider.<id>` block: what the study would generate for one job."""
    block: dict[str, Any] = {
        "name": f"spike {family}",
        "options": {"baseURL": relay_url + BASE_PATH[family], "apiKey": DUMMY_KEY},
        "models": {model: dict(MINIMAL_ENTRY if entry is None else entry)},
    }
    if npm:
        block["npm"] = NPM[family]
    return block


def models_file(family: Family, provider: str, model: str) -> dict[str, Any]:
    """The smallest `OPENCODE_MODELS_PATH` file that worked: one provider, one model."""
    return {
        provider: {
            "id": provider,
            "name": "Spike",
            "npm": NPM[family],
            "env": [],
            "models": {
                model: {
                    "id": model,
                    "name": "Spike model",
                    "tool_call": True,
                    "limit": {"context": 200000, "output": 8192},
                }
            },
        }
    }


def engine_config(provider: str, block: dict[str, Any], model: str) -> dict[str, Any]:
    """The trusted configuration of `config.build_engine_config`, with this provider block."""
    return {
        "permission": permission_block(),
        "agent": {
            "review": {
                "description": "Read-only review",
                "mode": "primary",
                "model": f"{provider}/{model}",
                "prompt": "You review code. Use read, grep and glob, then answer in JSON text.",
            }
        },
        "provider": {provider: block},
        "enabled_providers": [provider],
        "instructions": [],
        "plugin": [],
        "mcp": {},
        "lsp": False,
        "formatter": False,
        "snapshot": False,
        "share": "disabled",
        "autoupdate": False,
        "compaction": {"auto": False, "prune": False},
    }


class _Engine:
    def __init__(
        self,
        config: dict[str, Any],
        export: Path,
        home: Path,
        relay_url: str,
        models_path: Path | None,
    ) -> None:
        home.mkdir(parents=True, exist_ok=True)
        config_path = home / "opencode.json"
        config_path.write_text(json.dumps(config))
        ripgrep = ripgrep_binary()
        if ripgrep is None:
            raise AssertionError(
                "no ripgrep on this machine: set OPENCODE_TEST_PATH to its directory"
            )
        environment = engine_environment(
            proxy_url=relay_url,
            home=str(home),
            scratch_dir=str(home),
            node_bin=extra_path(),
            tools_dir=str(ripgrep.parent),
        )
        environment["OPENCODE_CONFIG"] = str(config_path)
        if models_path is not None:
            environment["OPENCODE_MODELS_PATH"] = str(models_path)
        self.export = str(export)
        self.log_path = home / "engine.log"
        self._log = self.log_path.open("wb")
        port = _free_port()
        self.base = f"http://127.0.0.1:{port}"
        self.process = subprocess.Popen(
            [
                str(opencode_binary()),
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                str(port),
                "--print-logs",
            ],
            env=environment,
            cwd=str(export),
            stdin=subprocess.DEVNULL,
            stdout=self._log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError("the engine exited: " + self.log_path.read_text()[-1500:])
            document: Any = None
            status = 0
            with contextlib.suppress(OSError):
                status, document = _call("GET", f"{self.base}/global/health", None, None, 2.0)
            healthy = cast("dict[str, Any]", document) if isinstance(document, dict) else {}
            if status == 200 and healthy.get("healthy") is True:
                return
            time.sleep(0.2)
        raise AssertionError("the engine did not become healthy")

    def stop(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=10)
        self._log.close()

    def log(self) -> str:
        return self.log_path.read_text(errors="replace")

    def resolved(self, provider: str, model: str) -> dict[str, Any]:
        status, document = _call("GET", f"{self.base}/config/providers", None, self.export)
        assert status == 200, document
        entry = next(p for p in document["providers"] if p["id"] == provider)
        return entry["models"][model]

    def turn(
        self,
        provider: str,
        model: str,
        *,
        title: str | None,
        variant: str | None,
    ) -> tuple[int, Any, list[Assistant]]:
        status, session = _call(
            "POST", f"{self.base}/session", {"title": title} if title else {}, self.export
        )
        assert status == 200, (status, session)
        body: dict[str, Any] = {
            "agent": "review",
            "model": {"providerID": provider, "modelID": model},
            "parts": [{"type": "text", "text": "Review src and answer in JSON."}],
        }
        if variant:
            body["variant"] = variant
        url = f"{self.base}/session/{session['id']}/message"
        reply_status, reply = _call("POST", url, body, self.export, TURN_SECONDS)
        _, history = _call("GET", url, None, self.export)
        return reply_status, reply, _assistants(history)


def _assistants(history: Any) -> list[Assistant]:
    steps: list[Assistant] = []
    messages: list[Any] = cast("list[Any]", history) if isinstance(history, list) else []
    for message in messages:
        info: dict[str, Any] = message.get("info") or {}
        if info.get("role") != "assistant":
            continue
        parts: list[dict[str, Any]] = message.get("parts") or []
        steps.append(
            Assistant(
                tokens=info.get("tokens") or {},
                cost=info.get("cost") or 0,
                finish=info.get("finish"),
                error=info.get("error"),
                tools=[p["tool"] for p in parts if p.get("type") == "tool"],
                text="".join(p.get("text", "") for p in parts if p.get("type") == "text"),
            )
        )
    return steps


@contextmanager
def _setup(
    scratch: Path,
    family: Family,
    *,
    provider: str | None,
    model: str | None,
    entry: Mapping[str, Any] | None,
    npm: bool,
    steps: int,
    thinking: str,
    judge: Judge | None,
    on_answer: OnAnswer | None,
    prepare: Callable[[ScriptedUpstream], None] | None,
    minimal_models_file: bool,
) -> Generator[tuple[_Engine, ScriptedUpstream, KeySwapRelay, str, str]]:
    default_provider, default_model = DEFAULT_IDS[family]
    provider, model = provider or default_provider, model or default_model
    export = make_export(scratch)
    with ScriptedUpstream(
        family,
        tool_script(export, steps, thinking),
        model,
        real_key=REAL_KEY,
        judge=judge,
        on_answer=on_answer,
    ) as upstream:
        if prepare is not None:
            prepare(upstream)
        with KeySwapRelay(family, upstream.url, dummy_key=DUMMY_KEY, real_key=REAL_KEY) as relay:
            if minimal_models_file:
                path = scratch / "models.json"
                path.write_text(json.dumps(models_file(family, provider, model)))
                block: dict[str, Any] = {
                    "options": {"baseURL": relay.url + BASE_PATH[family], "apiKey": DUMMY_KEY}
                }
            else:
                path = None
                block = provider_entry(family, relay.url, model, entry=entry, npm=npm)
            engine = _Engine(
                engine_config(provider, block, model), export, scratch / "home", relay.url, path
            )
            try:
                yield engine, upstream, relay, provider, model
            finally:
                engine.stop()
    shutil.rmtree(export, ignore_errors=True)


def native_run(
    scratch: Path,
    family: Family,
    *,
    provider: str | None = None,
    model: str | None = None,
    entry: Mapping[str, Any] | None = None,
    npm: bool = True,
    steps: int = 6,
    thinking: str = "",
    prepare: Callable[[ScriptedUpstream], None] | None = None,
    judge: Judge | None = None,
    on_answer: OnAnswer | None = None,
    title: str | None = SESSION_TITLE,
    ask_provider: str | None = None,
    ask_model: str | None = None,
    models_file: bool = False,
    variant: str | None = None,
) -> NativeRun:
    """One turn of the real engine: a tool loop of `steps` calls and a final text.

    `entry` replaces the model entry (None: `MINIMAL_ENTRY`), `npm=False` leaves the SDK unnamed,
    `models_file` moves provider and model into a minimal `OPENCODE_MODELS_PATH` file, `prepare`
    sets faults on the upstream, `judge` and `on_answer` add stricter rules to it, and `ask_*`
    name a provider or model the config does not know.
    """
    with _setup(
        scratch,
        family,
        provider=provider,
        model=model,
        entry=entry,
        npm=npm,
        steps=steps,
        thinking=thinking,
        judge=judge,
        on_answer=on_answer,
        prepare=prepare,
        minimal_models_file=models_file,
    ) as (engine, upstream, relay, provider_id, model_id):
        status, reply, assistants = engine.turn(
            ask_provider or provider_id,
            ask_model or model_id,
            title=title,
            variant=variant,
        )
        try:
            resolved = engine.resolved(provider_id, model_id)
        except (StopIteration, KeyError):
            resolved = {}  # the engine does not offer this model at all
        return NativeRun(
            family=family,
            upstream=upstream,
            relay=relay,
            http_status=status,
            reply=reply,
            assistants=assistants,
            resolved=resolved,
            log=engine.log(),
            scratch=scratch,
        )


def resolved_model(
    scratch: Path,
    family: Family,
    *,
    provider: str | None = None,
    model: str | None = None,
    entry: Mapping[str, Any] | None = None,
    npm: bool = True,
) -> dict[str, Any]:
    """What the engine makes of a model entry (`GET /config/providers`), without any turn."""
    with _setup(
        scratch,
        family,
        provider=provider,
        model=model,
        entry=entry,
        npm=npm,
        steps=0,
        thinking="",
        judge=None,
        on_answer=None,
        prepare=None,
        minimal_models_file=False,
    ) as (engine, _, _, provider_id, model_id):
        return engine.resolved(provider_id, model_id)
