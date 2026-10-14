# SPDX-License-Identifier: Apache-2.0
"""Loopback-only smart HTTP Git fake, backed by real upload-pack and dummy authentication."""

import base64
import contextlib
import os
import subprocess
import threading
from collections.abc import Generator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class GitServer:
    def __init__(self, repository: Path, token: str = "dummy-installation") -> None:
        self.repository = repository
        self.token = token
        self.status = 200
        self.requests: list[tuple[str, bytes]] = []
        self.stall = False
        self.chunked = False
        self.entered = threading.Event()
        self.release = threading.Event()
        self.closed = threading.Event()
        self.http: ThreadingHTTPServer | None = None

    def handler(self) -> type[BaseHTTPRequestHandler]:
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                pass

            def do_GET(self) -> None:
                self.reply(None)

            def do_POST(self) -> None:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
                    self.send_error(400)
                    return
                self.reply(self.rfile.read(size))

            def reply(self, request: bytes | None) -> None:
                expected = (
                    "Basic " + base64.b64encode(f"x-access-token:{fixture.token}".encode()).decode()
                )
                if self.headers.get("Authorization") != expected:
                    self.send_error(401)
                    return
                suffix = (
                    "/info/refs?service=git-upload-pack" if request is None else "/git-upload-pack"
                )
                if self.path != "/owner/base.git" + suffix:
                    self.send_error(404)
                    return
                fixture.requests.append((self.path, request or b""))
                fixture.entered.set()
                if fixture.stall:
                    fixture.release.wait(10)
                if fixture.status != 200:
                    self.send_error(fixture.status)
                    return
                args = ["git", "-c", "core.hooksPath=/dev/null", "upload-pack", "--stateless-rpc"]
                if request is None:
                    args.append("--advertise-refs")
                args.append(str(fixture.repository))
                result = subprocess.run(
                    args,
                    input=request or b"",
                    capture_output=True,
                    timeout=10,
                    env={
                        "PATH": os.defpath,
                        "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_CONFIG_GLOBAL": "/dev/null",
                        "HOME": "/nonexistent",
                    },
                )
                payload = result.stdout
                if request is None:
                    payload = b"001e# service=git-upload-pack\n0000" + payload
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/x-git-upload-pack-advertisement"
                    if request is None
                    else "application/x-git-upload-pack-result",
                )
                if fixture.chunked:
                    # GitHub streams responses without Content-Length; exercise the chunked
                    # framing path through the bounded reader.
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    try:
                        for start in range(0, len(payload), 4096):
                            part = payload[start : start + 4096]
                            self.wfile.write(f"{len(part):x}\r\n".encode() + part + b"\r\n")
                            self.wfile.flush()
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        fixture.closed.set()
                    return
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                try:
                    for start in range(0, len(payload), 4096):
                        self.wfile.write(payload[start : start + 4096])
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    fixture.closed.set()

        return Handler

    @property
    def url(self) -> str:
        assert self.http is not None
        return f"http://127.0.0.1:{self.http.server_port}/owner/base.git"


@contextlib.contextmanager
def git_server(repository: Path, token: str = "dummy-installation") -> Generator[GitServer]:
    fixture = GitServer(repository, token)
    fixture.http = ThreadingHTTPServer(("127.0.0.1", 0), fixture.handler())
    thread = threading.Thread(target=fixture.http.serve_forever, daemon=True)
    thread.start()
    try:
        yield fixture
    finally:
        fixture.release.set()
        fixture.http.shutdown()
        fixture.http.server_close()
        thread.join(timeout=5)
        assert not thread.is_alive()
