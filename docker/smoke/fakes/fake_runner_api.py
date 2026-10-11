"""Test helper of docker/smoke/compose.sh, never part of a deployment: a stand-in for the app's runner
API that hands out exactly one job and prints every report it receives.

It runs in a container of the runner image (Python standard library only) next to the real stack.
It checks the bearer token, so a runner that was wired with a wrong token gets 401 and never a job.
Every line it prints starts with a marker the smoke test greps for:

    CLAIM    <n>              a claim arrived (the first one is answered with the job)
    HEARTBEAT <job id>
    COMPLETE <job id> <JSON>  the body of the report (the lease token is left out)
"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["RUNNER_TOKEN"]
JOB_ID = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10"
LEASE_TOKEN = "smoke-lease-token-0123456789"
claims = 0


def say(line: str) -> None:
    print(line, flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: object | None = None) -> None:
        payload = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def do_GET(self) -> None:
        # The health check of this container.
        self._send(200, {"status": "ok"})

    def do_POST(self) -> None:
        global claims
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            say(f"REFUSED {self.path} (wrong or missing token)")
            self._send(401, {"error": {"code": "RUNNER_UNAUTHORIZED", "message": "token"}})
            return
        path = self.path
        if path == "/api/runners/v1/claim":
            claims += 1
            say(f"CLAIM {claims}")
            if claims > 1:
                self._send(204)
                return
            self._send(
                200,
                {
                    "version": 1,
                    "job": {
                        "id": JOB_ID,
                        "leaseToken": LEASE_TOKEN,
                        "leaseExpiresAt": "2099-01-01T00:00:00.000Z",
                        "heartbeatIntervalSeconds": 30,
                        "tokenExpiresAt": None,
                        "input": {
                            "prUrl": "https://github.com/acme/widgets/pull/7",
                            "command": "review",
                            "git": {
                                "provider": "github",
                                "baseUrl": "https://api.github.com",
                                "token": "smoke-git-token",
                                "botLogin": "code-reviewer[bot]",
                            },
                            "llm": {
                                "provider": "openrouter",
                                "model": "vendor/model-name",
                                "apiKey": "smoke-llm-key",
                            },
                            "env": {},
                        },
                    },
                },
            )
            return
        if path == f"/api/runners/v1/jobs/{JOB_ID}/heartbeat":
            say(f"HEARTBEAT {JOB_ID}")
            self._send(
                200,
                {
                    "version": 1,
                    "job": {
                        "id": JOB_ID,
                        "heartbeatAt": "2099-01-01T00:00:00.000Z",
                        "leaseExpiresAt": "2099-01-01T00:02:00.000Z",
                    },
                },
            )
            return
        if path == f"/api/runners/v1/jobs/{JOB_ID}/complete":
            body = json.loads(raw)
            result = body.get("result", {})
            say(f"COMPLETE {JOB_ID} {json.dumps(result, sort_keys=True)}")
            # The real app gives a job reported as runner_shutdown back to the queue.
            status = "queued" if result.get("errorCode") == "runner_shutdown" else "failed"
            self._send(
                200,
                {
                    "version": 1,
                    "job": {"id": JOB_ID, "status": status},
                    "alreadyCompleted": False,
                },
            )
            return
        self._send(404, {"error": {"code": "RUNNER_JOB_NOT_FOUND", "message": "no route"}})

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()  # noqa: S104
