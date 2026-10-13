# SPDX-License-Identifier: Apache-2.0

"""A protocol-shaped fake of the pinned OpenCode headless server (#197).

It is not a test file: the Dynamic Review integration tests start it as a subprocess exactly like
the runner starts the engine, so the production adapter, client and config generation run unchanged.
It speaks the verified API surface the adapter uses (`/global/health`, `/session`,
`/session/{id}/message`, `/session/{id}/abort`), calls the runner-owned model proxy like the engine
would, and can be scripted to answer badly, to break the message list and to leave a helper behind.

The script (`.fake-opencode-script.json`) and the trace (`.fake-opencode-trace.jsonl`) live in the
engine's own working directory, the export the runner gives it. Every key of the script is optional:

    {
      "version": "1.19.0",         # the health answer's version (a mismatch tests the refusal)
      "proxy_calls": 2,            # how often the message handler calls the model proxy
      "answer": "structured",      # "structured" | "text" | "none"
      "message_status": 200,
      "messages_status": 200,      # 400 reproduces the pinned structured-message codec defect
      "messages": [ ... ],         # the session's messages, with tool parts
      "messages_body": ...,        # any JSON as the 200 list answer (a malformed list)
      "spawn_helper": false        # leave a sleeping child in the engine's process group
    }

The trace records the pid, the helper pid, the proxy answers and the config the runner wrote, so a
test can assert on the whole run.
"""

import argparse
import json
import os
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
            status = int(script.get("messages_status", 200))
            if status != 200:
                _trace({"messages_status": status})
                self._answer(status, {"error": "Expected OutputFormatJsonSchema"})
                return
            self._answer(200, script.get("messages_body", script.get("messages", [])))
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

        answers: list[Any] = []
        for _ in range(int(script.get("proxy_calls", 0))):
            answers.append(self._call_proxy())
        _trace({"proxy_answers": answers})

        if "message_status" in script:
            self._answer(int(script["message_status"]), {"error": "scripted"})
            return
        answer = script.get("answer", "structured")
        document = script.get("findings")
        if answer == "none":
            self._answer(200, {"id": "msg-1", "parts": []})
        elif answer == "text":
            self._answer(
                200, {"id": "msg-1", "parts": [{"type": "text", "text": json.dumps(document)}]}
            )
        else:
            self._answer(200, {"id": "msg-1", "structured": document})

    def _call_proxy(self) -> int:
        """One model call, exactly like the engine's provider would make it: the key it presents is
        the one the runner wrote into the trusted config."""
        url = f"{_env('REVIEW_PROXY_URL')}/v1/chat/completions"
        body = json.dumps(
            {
                "model": "review-proxy/deepseek-v4.1-flash",
                "messages": [{"role": "user", "content": "review the change"}],
                "tools": [{"type": "function", "function": {"name": "StructuredOutput"}}],
                "tool_choice": "required",
            }
        ).encode("utf-8")
        request = Request(
            url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {_api_key()}"},
        )
        try:
            with urlopen(request, timeout=MESSAGE_TIMEOUT) as response:
                return response.status
        except HTTPError as error:
            return error.code
        except (URLError, OSError):
            return 0

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

    _trace({"pid": os.getpid()})
    server = ThreadingHTTPServer((args.hostname, args.port), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Stay alive until the runner ends the process group, like the real server.
    threading.Event().wait()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
