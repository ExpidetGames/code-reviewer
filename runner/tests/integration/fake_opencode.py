# SPDX-License-Identifier: LicenseRef-Proprietary

"""A protocol-shaped fake of the pinned OpenCode headless server (#197).

It is not a test file: the Dynamic Review integration tests start it as a subprocess exactly like
the runner starts the engine, so the production adapter, client and config generation run unchanged.
It speaks the verified API surface the adapter uses (`/global/health`, `/session`,
`/session/{id}/message`, `/session/{id}/abort`) in the shapes the real v1.19.0 binary answers with
(`{info: {structured}, parts}`), calls the runner-owned model proxy like the engine would (streamed,
with the whole history of tool calls and results in every request), and can be scripted to answer
badly, to break the message list and to leave a helper behind.

The script (`.fake-opencode-script.json`) and the trace (`.fake-opencode-trace.jsonl`) live in the
engine's own working directory, the export the runner gives it. Every key of the script is optional:

    {
      "version": "1.19.0",         # the health answer's version (a mismatch tests the refusal)
      "proxy_calls": 2,            # at most this many model calls per message
      "results": {"call-1": "text"},  # what the fake "executes" a tool call to (default "ok")
      "stream": true,              # ask the proxy for a stream, like the real engine (default)
      "answer": "structured",      # "structured" | "text" | "none"
      "answers": ["none", "structured"],  # the answer of each message in turn (the last repeats)
      "message_status": 200,
      "messages_status": 200,      # 400 reproduces the pinned structured-message codec defect
      "spawn_helper": false,       # leave a sleeping child in the engine's process group
      "exit_early": false          # leave that child behind and exit before serving (#202)
    }

The model loop is the engine's: each proxy answer with tool calls is "executed" (the scripted
result) and appended to the history of the next request; an answer without tool calls, or one that
calls `StructuredOutput`, ends it. The trace records the pid, the process environment, the helper
pid, the proxy answers, whether the message list was requested and the config the runner wrote, so
a test can assert on the whole run.
"""

import argparse
import json
import os
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from code_reviewer_runner.job_loop.jsonvalues import as_object

# The fake reads its script and writes its trace in the engine's own working directory (the export
# the runner gives it), so the adapter needs no test-only environment seam: the environment stays
# the closed one the runner builds.
# How many messages this server answered so far (it answers one at a time).
SERVED: list[int] = [0]
SCRIPT_FILE = ".fake-opencode-script.json"
TRACE_FILE = ".fake-opencode-trace.jsonl"

MESSAGE_TIMEOUT = 30.0


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _api_key() -> str:
    path = _env("OPENCODE_CONFIG")
    config = (
        as_object(_read_json(Path(path).read_bytes())) if path and Path(path).is_file() else None
    )
    providers = as_object(config.get("provider")) if config else None
    entry = as_object(providers.get("review-proxy")) if providers else None
    options = as_object(entry.get("options")) if entry else None
    key = options.get("apiKey") if options else None
    return key if isinstance(key, str) else ""


def _model() -> str:
    """The model id the runner wrote into the trusted config, like the engine would call it."""
    path = _env("OPENCODE_CONFIG")
    config = (
        as_object(_read_json(Path(path).read_bytes())) if path and Path(path).is_file() else None
    )
    providers = as_object(config.get("provider")) if config else None
    entry = as_object(providers.get("review-proxy")) if providers else None
    models = as_object(entry.get("models")) if entry else None
    return (
        next(iter(models), "deepseek/deepseek-v4.1-flash")
        if models
        else "deepseek/deepseek-v4.1-flash"
    )


def _workdir() -> Path:
    return Path.cwd()


def _script() -> dict[str, Any]:
    path = _workdir() / SCRIPT_FILE
    if not path.is_file():
        return {}
    value: Any = json.loads(path.read_text(encoding="utf-8"))
    return as_object(value) or {}


def _trace(entry: dict[str, Any]) -> None:
    with open(_workdir() / TRACE_FILE, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry) + "\n")


def _assistant(body: bytes, stream: bool) -> dict[str, Any] | None:
    """The assistant message out of a plain completion or of an event stream, like the engine's."""
    if not stream:
        document = as_object(_read_json(body))
        choices: Any = document.get("choices") if document else None
        entries: list[Any] = choices if isinstance(choices, list) else []  # pyright: ignore[reportUnknownVariableType]
        first = as_object(entries[0]) if entries else None
        return as_object(first.get("message")) if first else None
    text = ""
    calls: dict[int, dict[str, Any]] = {}
    for line in body.decode("utf-8").splitlines():
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        chunk = as_object(_read_json(line[len("data: ") :].encode("utf-8")))
        choice = as_object(chunk["choices"][0]) if chunk else None
        delta = as_object(choice.get("delta")) if choice else None
        if delta is None:
            continue
        text += delta.get("content") or ""
        streamed: list[dict[str, Any]] = delta.get("tool_calls") or []
        for call in streamed:
            slot = calls.setdefault(int(call["index"]), {"type": "function", "function": {}})
            function: dict[str, Any] = call["function"]
            known: dict[str, Any] = slot["function"]
            slot["id"] = call.get("id", slot.get("id"))
            known["name"] = function.get("name", known.get("name"))
            known["arguments"] = known.get("arguments", "") + (function.get("arguments") or "")
    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    if calls:
        message["tool_calls"] = [calls[index] for index in sorted(calls)]
    return message


def _read_json(body: bytes) -> Any:
    try:
        return json.loads(body)
    except ValueError:
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "fake-opencode/1"
    protocol_version = "HTTP/1.1"

    def _answer(self, status: int, body: Any) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self) -> bytes:
        length = self.headers.get("Content-Length", "")
        return self.rfile.read(int(length)) if length.isdigit() else b""

    def do_GET(self) -> None:
        script = _script()
        if self.path == "/global/health":
            self._answer(200, {"healthy": True, "version": script.get("version", "1.19.0")})
            return
        if self.path.endswith("/message"):
            _trace({"messages_requested": True})
            status = int(script.get("messages_status", 200))
            if status != 200:
                self._answer(status, {"error": "Expected OutputFormatJsonSchema"})
                return
            self._answer(200, [])
            return
        self._answer(404, {"error": "not found"})

    def do_POST(self) -> None:
        script = _script()
        body = self._body()
        if self.path == "/session":
            self._answer(200, {"id": "ses-fake-1"})
            return
        if self.path.endswith("/abort"):
            _trace({"abort": True})
            self._answer(200, {})
            return
        if self.path.endswith("/message"):
            self._message(script, body)
            return
        self._answer(404, {"error": "not found"})

    def _message(self, script: dict[str, Any], body: bytes) -> None:
        config_path = _env("OPENCODE_CONFIG")
        config: Any = None
        if config_path and Path(config_path).is_file():
            config = _read_json(Path(config_path).read_bytes())
        _trace({"config": config, "message_request": _read_json(body)})
        if bool(script.get("spawn_helper", False)):
            helper = subprocess.Popen(["sleep", "60"])
            _trace({"helper_pid": helper.pid})

        _trace({"proxy_answers": self._model_loop(script)})

        if "message_status" in script:
            self._answer(int(script["message_status"]), {"error": "scripted"})
            return
        answers: list[Any] = script.get("answers") or [script.get("answer", "structured")]
        answer = answers[min(SERVED[0], len(answers) - 1)]
        SERVED[0] += 1
        document = script.get("findings")
        if answer == "none":
            # The shape the pinned server gives a turn that ended without a structured answer.
            info = {
                "id": "msg-1",
                "finish": "stop",
                "error": {"name": "StructuredOutputError", "data": {"retries": 0}},
            }
            self._answer(200, {"info": info, "parts": []})
        elif answer == "text":
            self._answer(
                200,
                {
                    "info": {"id": "msg-1"},
                    "parts": [{"type": "text", "text": json.dumps(document)}],
                },
            )
        else:
            self._answer(200, {"info": {"id": "msg-1", "structured": document}, "parts": []})

    def _model_loop(self, script: dict[str, Any]) -> list[int]:
        """The engine's loop: ask the model, run what it asks for, send the whole history again."""
        messages: list[dict[str, Any]] = [{"role": "user", "content": "review the change"}]
        results: dict[str, Any] = as_object(script.get("results")) or {}
        statuses: list[int] = []
        for _ in range(int(script.get("proxy_calls", 0))):
            status, answer = self._call_proxy(messages, bool(script.get("stream", True)))
            statuses.append(status)
            if status != 200 or answer is None:
                break
            messages.append(answer)
            calls: list[dict[str, Any]] = answer.get("tool_calls") or []
            if not calls or any(call["function"]["name"] == "StructuredOutput" for call in calls):
                break
            for call in calls:
                content = results.get(call["id"], "ok")
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": content})
        return statuses

    def _call_proxy(
        self, messages: list[dict[str, Any]], stream: bool
    ) -> tuple[int, dict[str, Any] | None]:
        """One model call, exactly like the engine's provider would make it: the key it presents is
        the one the runner wrote into the trusted config. Returns the assistant message."""
        url = f"{_env('REVIEW_PROXY_URL')}/v1/chat/completions"
        document: dict[str, Any] = {
            "model": f"review-proxy/{_model()}",
            "messages": messages,
            "tools": [{"type": "function", "function": {"name": "StructuredOutput"}}],
            "tool_choice": "required",
            "max_tokens": 32000,
        }
        if stream:
            document["stream"] = True
            document["stream_options"] = {"include_usage": True}
        request = Request(
            url,
            data=json.dumps(document).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {_api_key()}"},
        )
        try:
            with urlopen(request, timeout=MESSAGE_TIMEOUT) as response:
                body = response.read()
                return response.status, _assistant(body, stream)
        except HTTPError as error:
            return error.code, None
        except (URLError, OSError):
            return 0, None

    def log_message(self, format: str, *args: Any) -> None:
        return


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="fake-opencode")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve")
    serve.add_argument("--hostname", default="127.0.0.1")
    serve.add_argument("--port", type=int, required=True)
    serve.add_argument("--print-logs", action="store_true")
    args = parser.parse_args(argv)

    config_path = Path(_env("OPENCODE_CONFIG"))
    scratch_dir = config_path.parent
    config_mode = stat.S_IMODE(config_path.stat().st_mode) if config_path.is_file() else None
    scratch_mode = stat.S_IMODE(scratch_dir.stat().st_mode) if scratch_dir.is_dir() else None
    _trace(
        {
            "pid": os.getpid(),
            "port": args.port,
            "env": dict(os.environ),
            "config_mode": config_mode,
            "scratch_mode": scratch_mode,
        }
    )
    if bool(_script().get("exit_early", False)):
        # The leader ends on its own while a helper keeps the process group alive.
        helper = subprocess.Popen(["sleep", "60"])
        _trace({"helper_pid": helper.pid})
        return 0
    server = ThreadingHTTPServer((args.hostname, args.port), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Stay alive until the runner ends the process group, like the real server.
    threading.Event().wait()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
