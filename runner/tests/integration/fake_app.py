# SPDX-License-Identifier: Apache-2.0

"""Test helper, not a test: the app's runner API on loopback, built from the contract file.

It checks every request the runner sends (token, runner id, body against the contract schema) and
records violations, so a test can assert that the loop spoke the contract. Answers can be scripted
per call to simulate 5xx, a lost lease and the like.
"""

import json
import re
import socket
import threading
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "runner-api.v1.json"
SCHEMA: dict[str, Any] = json.loads(CONTRACT.read_text(encoding="utf-8"))
RUNNER_TOKEN = "fake-app-runner-token-0123456789-abcdef-0123456789"
_ROUTE = re.compile(r"/api/runners/v1/(claim|jobs/([^/]+)/(heartbeat|complete))")


def _validator(definition: str) -> Draft202012Validator:
    return Draft202012Validator(
        {"$schema": SCHEMA["$schema"], "$ref": f"#/$defs/{definition}", "$defs": SCHEMA["$defs"]}
    )


def claim_response(job_id: str, job_input: dict[str, Any], interval: int = 30) -> dict[str, Any]:
    return {
        "version": 1,
        "job": {
            "id": job_id,
            "leaseToken": f"lease-{job_id}",
            "leaseExpiresAt": "2026-10-10T12:02:00.000Z",
            "heartbeatIntervalSeconds": interval,
            "tokenExpiresAt": None,
            "input": job_input,
        },
    }


def problems(definition: str, document: Any) -> list[str]:
    """What is wrong with a document, according to the contract (empty: it is valid)."""
    validator = _validator(definition)
    return [error.message[:200] for error in validator.iter_errors(document)]  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]


class Scripted:
    def __init__(self, status: int, body: Any = None, headers: dict[str, str] | None = None):
        self.status = status
        self.body = body
        self.headers = headers or {}


class FakeApp:
    def __init__(self) -> None:
        self.token = RUNNER_TOKEN
        self.queue: list[dict[str, Any]] = []
        self.requests: list[dict[str, Any]] = []
        self.violations: list[str] = []
        self.completions: list[dict[str, Any]] = []
        self.heartbeats: list[str] = []
        self.claims = 0
        self.lost: set[str] = set()
        # #396: the jobs a newer push replaced; their heartbeats answer `superseded: true`.
        self.superseded: set[str] = set()
        self.complete_status = "succeeded"
        self._scripted: dict[str, list[Scripted]] = defaultdict(list)
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self.url = ""

    def script(self, kind: str, *answers: Scripted) -> None:
        """The next calls of `kind` ("claim", "heartbeat", "complete") answer like this."""
        with self._lock:
            self._scripted[kind].extend(answers)

    def start(self) -> "FakeApp":
        app = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                status, headers, body = app._handle(self.path, dict(self.headers), raw)
                payload = b"" if body is None else json.dumps(body).encode()
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if status != 204:
                    self.wfile.write(payload)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        ).start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def _violation(self, text: str) -> None:
        self.violations.append(text)

    def _handle(
        self, path: str, headers: dict[str, str], raw: bytes
    ) -> tuple[int, dict[str, str], Any]:
        with self._lock:
            match = _ROUTE.fullmatch(path)
            if match is None:
                return 404, {}, {"error": {"code": "RUNNER_JOB_NOT_FOUND", "message": "no route"}}
            kind = "claim" if match.group(1) == "claim" else match.group(3)
            job_id = match.group(2)
            body: Any = json.loads(raw) if raw else None
            self.requests.append({"kind": kind, "job": job_id, "headers": headers, "body": body})
            if headers.get("Authorization") != f"Bearer {self.token}":
                return 401, {}, {"error": {"code": "RUNNER_UNAUTHORIZED", "message": "token"}}
            if not re.fullmatch(
                r"[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}", headers.get("X-Runner-Id", "")
            ):
                self._violation("X-Runner-Id missing or invalid")
            if self._scripted[kind]:
                answer = self._scripted[kind].pop(0)
                return answer.status, answer.headers, answer.body
            if kind == "claim":
                self.claims += 1
                # #195: the claim request is validated against the contract too, so a runner cannot
                # send an engines body the app would refuse (or omit it after this version).
                if body is not None:
                    for problem in problems("ClaimRequest", body):
                        self._violation(f"claim request: {problem}")
                if not self.queue:
                    return 204, {}, None
                response = self.queue.pop(0)
                for problem in problems("ClaimResponse", response):
                    self._violation(f"claim response: {problem}")
                return 200, {}, response
            assert job_id is not None
            definition = "HeartbeatRequest" if kind == "heartbeat" else "CompleteRequest"
            for problem in problems(definition, body):
                self._violation(f"{kind} request: {problem}")
            if len(raw) > 65536:
                self._violation("complete request over 64 KiB")
            if job_id in self.lost:
                return 409, {}, {"error": {"code": "RUNNER_LEASE_LOST", "message": "lost"}}
            if kind == "heartbeat":
                self.heartbeats.append(job_id)
                return (
                    200,
                    {},
                    {
                        "version": 1,
                        "job": {
                            "id": job_id,
                            "heartbeatAt": "2026-10-10T12:00:30.000Z",
                            "leaseExpiresAt": "2026-10-10T12:02:30.000Z",
                            **({"superseded": True} if job_id in self.superseded else {}),
                        },
                    },
                )
            self.completions.append(
                {"job": job_id, "lease": body["leaseToken"], "result": body["result"]}
            )
            return (
                200,
                {},
                {
                    "version": 1,
                    "job": {"id": job_id, "status": self.complete_status},
                    "alreadyCompleted": False,
                },
            )

    def wait_for(self, predicate: Any, seconds: float = 20.0) -> bool:
        import time

        end = time.monotonic() + seconds
        while time.monotonic() < end:
            with self._lock:
                if predicate():
                    return True
            time.sleep(0.02)
        return False


class RawServer:
    """A loopback server that answers every connection with fixed bytes, then closes it."""

    def __init__(self, answer: bytes) -> None:
        self._answer = answer
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self.url = f"http://127.0.0.1:{self._listener.getsockname()[1]}"
        self.connections = 0
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            self.connections += 1
            with connection:
                connection.settimeout(2)
                try:
                    connection.recv(65536)
                    connection.sendall(self._answer)
                except OSError:
                    pass

    def close(self) -> None:
        self._listener.close()
