# SPDX-License-Identifier: LicenseRef-Proprietary

"""Test helper, not a test: the fake App of `fakes/dispatcher-app/` (#318) as a process on loopback.

The Worker tests (#323) run against the fake that the Dispatcher and the journeys share, not against
a Python copy of it. `main.ts` is run by Node as it is (type stripping); the control API
(`/__fake/*`) enqueues jobs, scripts failures and loses leases. The fake answers the Worker API with
the bodies of the contract examples.
"""

import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

MAIN = Path(__file__).resolve().parents[3] / "fakes" / "dispatcher-app" / "main.ts"
DISPATCHER_TOKEN = "fake-dispatcher-token"
_LISTENING = re.compile(r"Fake App listening on (http://\S+)")
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class FakeAppProcess:
    def __init__(self, host: str = "127.0.0.1") -> None:
        # The image smoke test (docker/smoke/worker_once_fake_app.py) listens on all interfaces so
        # that a container on the bridge network reaches it through the host gateway.
        self._host = host
        self.url = ""
        self._process: subprocess.Popen[str] | None = None

    def start(self) -> "FakeAppProcess":
        node = shutil.which("node")
        assert node is not None, "the fake App needs Node.js (see .nvmrc)"
        self._process = subprocess.Popen(
            [node, str(MAIN)],
            env={
                "PATH": os.environ["PATH"],
                "DISPATCHER_APP_FAKE_PORT": "0",
                "DISPATCHER_APP_FAKE_HOST": self._host,
                "DISPATCHER_APP_FAKE_TOKEN": DISPATCHER_TOKEN,
            },
            stdout=subprocess.PIPE,
            text=True,
        )
        assert self._process.stdout is not None
        found = _LISTENING.search(self._process.stdout.readline())
        assert found is not None, "the fake App did not say where it listens"
        self.url = found.group(1)
        return self

    def stop(self) -> None:
        process = self._process
        if process is None:
            return
        process.terminate()
        try:
            process.wait(10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        if process.stdout is not None:
            process.stdout.close()
        self._process = None

    # -- the control API and the Dispatcher API -----------------------------------------------

    def _call(
        self, method: str, path: str, body: dict[str, Any] | None = None, token: str | None = None
    ) -> Any:
        headers = {"Content-Type": "application/json", "X-Runner-Id": "worker-test-pool"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.url}{path}", data=data, method=method, headers=headers
        )
        try:
            with _OPENER.open(request, timeout=10) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raw = error.read()
        return json.loads(raw) if raw else None

    def enqueue(self, review_kind: str = "diff") -> str:
        return self._call("POST", "/__fake/enqueue", {"reviewKind": review_kind})["id"]

    def claim(self, job_id: str, engines: tuple[str, ...] = ("pr-agent",)) -> str:
        """Claim the job as a Dispatcher would and return the per-job credential."""
        answer = self._call(
            "POST",
            "/api/runners/v1/claim",
            {"jobId": job_id, "engines": list(engines), "features": ["worker_credential"]},
            token=DISPATCHER_TOKEN,
        )
        assert answer is not None, "the fake App has no such job to claim"
        return answer["job"]["credential"]

    def script(self, route: str, steps: list[dict[str, Any]]) -> None:
        self._call("POST", "/__fake/script", {"route": route, "steps": steps})

    def lose_lease(self, job_id: str) -> None:
        self._call("POST", "/__fake/lose-lease", {"jobId": job_id})

    def supersede(self, job_id: str) -> None:
        """A newer push replaced the run: the heartbeats answer `superseded` from now on."""
        self._call("POST", "/__fake/supersede", {"jobId": job_id})

    def requests(self) -> list[dict[str, Any]]:
        return self._call("GET", "/__fake/requests")

    def results(self, job_id: str) -> list[dict[str, Any]]:
        return self._call("GET", f"/__fake/results?jobId={job_id}")
