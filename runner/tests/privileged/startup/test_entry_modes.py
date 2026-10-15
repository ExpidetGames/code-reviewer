# SPDX-License-Identifier: Apache-2.0

"""The entry modes of the Worker image under the production flags of the container (#331).

`probe` and `worker-once` are what a Sandbox VM runs (#324, #329, #331): the same startup as the
legacy loop, plus the read-only root of the hardened container spec. This suite's mount namespace
provides it next to the capabilities (`scripts/run_privileged_offline.sh`: root, exactly the eight
capabilities, `no-new-privileges`, every disk filesystem read-only, a tmpfs on `/run` and `/tmp`).
The tests start the real entry point as a process of its own, the way the image does, and judge
what it prints and leaves behind.

This namespace has no pinned engine in `/opt/code-reviewer/pins`: the layout of the image (tools
and pins) is the Dynamic e2e lane's (`scripts/dynamic_e2e_namespace.sh`, step 3b, which proves the
passing verdict). Here the probe must therefore fail closed on exactly that and on nothing of the
hardening: every check of the container itself (root, the engine user, the network rules, the end
of `NET_ADMIN` and `SETPCAP`, the read-only root) has passed by the time it names the missing pin.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, ClassVar

import pytest
from privileged_support import ENGINE_UID, RUNNER_ENVIRONMENT, ipv6_settings_restored

from code_reviewer_runner.dynamic_review.netguard import EgressMode, table_family, table_name

ENGINES_FILE = Path("/run/code-reviewer-engines.json")
# What the hardening checks of the self-check name (docs/dynamic-review.md, "The startup
# self-check"): none of them may be the reason in this namespace, which has the container's flags.
HARDENING_REASONS = {
    "not_root_supervisor",
    "engine_user_invalid",
    "network_rules_not_installed",
    "capabilities_not_dropped",
    "root_filesystem_writable",
    "ipv6_not_disabled",
}
CREDENTIAL = "crj_dummy-per-job-credential-0123456789-abcdefghijkl"
JOB_ID = "00000000-0000-4000-8000-000000000001"


def nft(*arguments: str) -> None:
    path = shutil.which("nft", path="/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin")
    assert path is not None, "nft is not installed"
    subprocess.run([path, *arguments], capture_output=True, text=True, timeout=30, check=False)


@pytest.fixture(autouse=True)
def clean_namespace() -> Iterator[None]:
    """The rules of a start outlive its process: clear them around each test."""

    def clear() -> None:
        for mode in EgressMode:
            nft("delete", "table", table_family(mode), table_name(ENGINE_UID))
        ENGINES_FILE.unlink(missing_ok=True)

    with ipv6_settings_restored():
        clear()
        yield
        clear()


def run_entry(
    *arguments: str, stdin: str = "", extra: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """The real entry point as a process of its own, in the environment of the Dynamic container."""
    environment = {
        **os.environ,
        **RUNNER_ENVIRONMENT,
        "PYTHONDONTWRITEBYTECODE": "1",
        **(extra or {}),
    }
    return subprocess.run(
        [sys.executable, "-m", "code_reviewer_runner", *arguments],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
        env=environment,
    )


# #331-privileged-probe
def test_probe_prints_one_closed_verdict_and_fails_closed_on_the_missing_tools_only() -> None:
    done = run_entry("probe")

    assert done.returncode == 0, done.stderr
    lines = done.stdout.strip().splitlines()
    assert len(lines) == 1, done.stdout
    verdict = json.loads(lines[0])
    assert set(verdict) == {"version", "engines", "reasons"}
    assert verdict["version"] == 1
    # No engine is advertised without the pinned tools; the reason is what the layout lacks first.
    assert verdict["engines"] == ["pr-agent"]
    assert len(verdict["reasons"]) == 1, verdict
    assert verdict["reasons"][0] not in HARDENING_REASONS, verdict
    # The verdict holds no value of the environment.
    assert RUNNER_ENVIRONMENT["RUNNER_TOKEN"] not in done.stdout + done.stderr


# #331-privileged-probe
def test_the_container_hardening_holds_when_the_probe_names_its_reason() -> None:
    done = run_entry("probe")

    # Had NET_ADMIN or SETPCAP not been dropped, or the root been writable, the verdict would say so
    # first.
    verdict = json.loads(done.stdout.strip().splitlines()[-1])
    assert not HARDENING_REASONS & set(verdict["reasons"])
    # The rules of the engine user were installed by this very start (the fixture cleared them).
    path = shutil.which("nft", path="/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin")
    assert path is not None
    listing = subprocess.run(
        [path, "list", "tables"], capture_output=True, text=True, timeout=30, check=False
    )
    assert table_name(ENGINE_UID) in listing.stdout, listing.stdout


# #331-privileged-probe
def test_probe_leaves_the_same_verdict_in_the_engines_file_for_root_only() -> None:
    done = run_entry("probe")

    verdict = json.loads(done.stdout.strip().splitlines()[-1])
    assert json.loads(ENGINES_FILE.read_text(encoding="utf-8")) == verdict
    status = ENGINES_FILE.stat()
    assert stat.S_ISREG(status.st_mode)
    assert stat.S_IMODE(status.st_mode) == 0o600
    assert status.st_uid == 0


class _RecordingApp(BaseHTTPRequestHandler):
    seen: ClassVar[list[tuple[str, str, str]]] = []

    def do_GET(self) -> None:
        self.seen.append((self.command, self.path, self.headers.get("Authorization", "")))
        body = json.dumps(
            {
                "error": {
                    "code": "WORKER_CREDENTIAL_INVALID",
                    "message": "The credential is invalid.",
                }
            }
        ).encode()
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET

    def log_message(self, format: str, *args: Any) -> None:
        return


@pytest.fixture
def recording_app() -> Iterator[tuple[str, list[tuple[str, str, str]]]]:
    handler = type("Handler", (_RecordingApp,), {"seen": []})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", handler.seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=10)


# #331-privileged-worker-once
def test_worker_once_runs_the_startup_then_talks_to_the_given_app_with_the_credential_only(
    recording_app: tuple[str, list[tuple[str, str, str]]],
) -> None:
    url, seen = recording_app
    start = json.dumps({"appUrl": url, "jobId": JOB_ID, "credential": CREDENTIAL})

    done = run_entry("worker-once", stdin=start)

    # The app refuses the credential: the Worker could not fetch its job, a setup error (2).
    assert done.returncode == 2, done.stderr
    assert seen, "the Worker never asked the app"
    assert all(path.startswith("/api/workers/v1/") for _, path, _ in seen), seen
    assert all(header == f"Bearer {CREDENTIAL}" for _, _, header in seen), seen
    # The credential is on no output, and the startup ran first: the verdict file is there.
    assert CREDENTIAL not in done.stdout + done.stderr
    assert json.loads(ENGINES_FILE.read_text(encoding="utf-8"))["engines"] == ["pr-agent"]


# #331-privileged-worker-once
@pytest.mark.parametrize("stdin", ["", "not json", '{"appUrl": "http://127.0.0.1:9"}'])
def test_worker_once_without_a_usable_start_document_does_nothing_and_exits_with_a_setup_error(
    stdin: str,
) -> None:
    done = run_entry("worker-once", stdin=stdin)

    assert done.returncode == 2, done.stderr
    assert done.stdout == ""
    # The startup ran before the document was read, as in every mode.
    assert ENGINES_FILE.exists()
