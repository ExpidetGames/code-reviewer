# SPDX-License-Identifier: LicenseRef-Proprietary

"""A stand-in for the engine process, run as the dedicated user by the privileged suite (#197).

Standard library only, because it runs under the system interpreter as another user. It answers
the three requests the adapter needs to start (`/global/health`, `POST /session`, the message call,
which it holds open like an engine that is working), and writes down what the process could and
could not do as that user, into the `TMPDIR` the runner gave it: its ids and capabilities, whether
it can read its own config or the supervisor's state, whether it can write to the export, and
whether it can reach the targets the test listed. A helper it starts in a session of its own does
the same network attempts and then ignores SIGTERM: the part of a process tree that a process group
kill does not reach.

    stub_engine.py [--escape-helper] serve --hostname H --port P [--print-logs]
"""

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def tmpdir() -> Path:
    return Path(os.environ["TMPDIR"])


def write(name: str, document: dict[str, Any]) -> None:
    target = tmpdir() / name
    temporary = tmpdir() / f".{name}.part"
    temporary.write_text(json.dumps(document), encoding="utf-8")
    temporary.replace(target)


def reach(targets: list[list[Any]]) -> dict[str, bool]:
    """Which of the (label, host, port) targets this process can open a connection to."""
    reached: dict[str, bool] = {}
    for label, host, port in targets:
        try:
            with socket.create_connection((host, int(port)), timeout=2):
                reached[str(label)] = True
        except OSError:
            reached[str(label)] = False
    return reached


def send_datagram(host: str, port: int) -> None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as datagram:
            datagram.sendto(b"engine", (host, port))
    except OSError:
        pass


def can(action: Any) -> bool:
    try:
        action()
    except OSError:
        return False
    return True


def status_fields() -> dict[str, str]:
    """The capability sets and `no_new_privs` of this process, as the kernel reports them."""
    wanted = ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs")
    found: dict[str, str] = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        name, _, value = line.partition(":")
        if name in wanted:
            found[name] = value.strip()
    return found


def facts(targets: dict[str, Any]) -> dict[str, Any]:
    config = Path(os.environ["OPENCODE_CONFIG"])
    export = Path.cwd()
    supervisor = os.getppid()

    def write_export() -> None:
        (export / ".write-probe").write_text("x")

    def read_supervisor_environment() -> None:
        Path(f"/proc/{supervisor}/environ").read_bytes()

    def become_root() -> None:
        os.setuid(0)

    return {
        "uid": os.getuid(),
        "euid": os.geteuid(),
        "gid": os.getgid(),
        "groups": os.getgroups(),
        "status": status_fields(),
        "pid": os.getpid(),
        "environment": dict(os.environ),
        "can_read_config": can(lambda: config.read_bytes()),
        "can_list_job_directory": can(lambda: list(config.parent.iterdir())),
        "can_write_export": can(write_export),
        "can_read_supervisor_environment": can(read_supervisor_environment),
        "can_become_root": can(become_root),
        "reached": reach(targets.get("tcp", [])),
        "config_text": config.read_text(encoding="utf-8") if config.is_file() else None,
    }


def helper_main() -> None:
    """The leftover: its own session, the same network attempts, deaf to SIGTERM."""
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    targets_file = tmpdir() / "targets.json"
    targets: dict[str, Any] = json.loads(targets_file.read_text()) if targets_file.is_file() else {}
    write(
        "helper.json",
        {"pid": os.getpid(), "sid": os.getsid(0), "reached": reach(targets.get("tcp", []))},
    )
    for host, port in targets.get("udp", []):
        send_datagram(host, int(port))
    while True:
        time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    server_version = "stub-engine/1"
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, document: dict[str, Any]) -> None:
        payload = json.dumps(document).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/global/health":
            self._send(200, {"healthy": True, "version": "1.19.0"})
        else:
            self._send(404, {})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        if self.path == "/session":
            self._send(200, {"id": "ses_stub"})
        elif self.path.endswith("/abort"):
            self._send(200, {})
        else:
            # A message call: the engine is working. It never finishes by itself.
            time.sleep(600)
            self._send(500, {})

    def log_message(self, format: str, *args: Any) -> None:
        return


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="stub-engine")
    parser.add_argument("--escape-helper", action="store_true")
    parser.add_argument("--helper", action="store_true")
    subparsers = parser.add_subparsers(dest="command")
    serve = subparsers.add_parser("serve")
    serve.add_argument("--hostname", default="127.0.0.1")
    serve.add_argument("--port", type=int, required=True)
    serve.add_argument("--print-logs", action="store_true")
    args = parser.parse_args(argv)
    if args.helper:
        helper_main()
        return 0
    targets_file = tmpdir() / "targets.json"
    targets: dict[str, Any] = json.loads(targets_file.read_text()) if targets_file.is_file() else {}
    write("facts.json", facts(targets))
    for host, port in targets.get("udp", []):
        send_datagram(host, int(port))
    if args.escape_helper:
        subprocess.Popen(
            [sys.executable, __file__, "--helper"],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    server = ThreadingHTTPServer((args.hostname, args.port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
