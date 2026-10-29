# SPDX-License-Identifier: LicenseRef-Proprietary

"""The support code of the native provider engine tests (#546) must not leave a process behind.

`opencode_native._Engine` starts `opencode serve` in its constructor and waits for it to be healthy.
A constructor that raises leaves no `with` block to stop the process, so the engine has to stop it
itself, or an `opencode serve` is orphaned on the machine that ran the test, for good.
"""

import contextlib
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any, ClassVar

import opencode_native
import pytest
from opencode_native import _Engine, make_export  # pyright: ignore[reportPrivateUsage]

pytestmark = pytest.mark.engine


class RecordingPopen(subprocess.Popen[bytes]):
    started: ClassVar[list["RecordingPopen"]] = []

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        RecordingPopen.started.append(self)


# #546-T01
def test_an_engine_that_does_not_come_up_healthy_is_stopped_before_the_error_leaves_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A stand-in that accepts `serve` and never answers the health check.
    stand_in = tmp_path / "opencode"
    stand_in.write_text("#!/bin/sh\nexec sleep 300\n")
    stand_in.chmod(0o755)
    monkeypatch.setattr(opencode_native, "opencode_binary", lambda: stand_in)
    monkeypatch.setattr(opencode_native, "ripgrep_binary", lambda: tmp_path / "rg")
    monkeypatch.setattr(opencode_native, "HEALTH_SECONDS", 1.0)
    monkeypatch.setattr(opencode_native.subprocess, "Popen", RecordingPopen)
    RecordingPopen.started.clear()

    try:
        with pytest.raises(AssertionError, match="did not become healthy"):
            _Engine({}, make_export(tmp_path), tmp_path / "home", "http://127.0.0.1:9", None)

        (process,) = RecordingPopen.started
        assert process.poll() is not None
    finally:
        for process in RecordingPopen.started:  # never leave the stand-in running, whatever happens
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()


STAND_IN_THAT_LOSES_THE_PORT_ONCE = """#!{python}
import http.server, json, os, sys

marker = {marker!r}
if not os.path.exists(marker):
    open(marker, "w").close()
    sys.exit(1)  # the engine that finds its port taken exits instead of serving
port = int(sys.argv[sys.argv.index("--port") + 1])


class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({{"healthy": True}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", port), Health).serve_forever()
"""


# #713-T01: several engines start at once under xdist; a port that was free when it was chosen can
# be taken when the engine binds it
def test_an_engine_that_finds_its_port_taken_is_started_again_on_another_port(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stand_in = tmp_path / "opencode"
    stand_in.write_text(
        STAND_IN_THAT_LOSES_THE_PORT_ONCE.format(
            python=sys.executable, marker=str(tmp_path / "once")
        )
    )
    stand_in.chmod(0o755)
    monkeypatch.setattr(opencode_native, "opencode_binary", lambda: stand_in)
    monkeypatch.setattr(opencode_native, "ripgrep_binary", lambda: tmp_path / "rg")
    monkeypatch.setattr(opencode_native.subprocess, "Popen", RecordingPopen)
    RecordingPopen.started.clear()
    engine = None

    try:
        engine = _Engine({}, make_export(tmp_path), tmp_path / "home", "http://127.0.0.1:9", None)

        first, second = RecordingPopen.started
        assert first.poll() is not None
        assert second.poll() is None
        assert engine.base.endswith(str(_port_of(second.args)))
    finally:
        if engine is not None:
            engine.stop()
        for process in RecordingPopen.started:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def _port_of(argv: Any) -> int:
    arguments = [str(a) for a in argv]
    return int(arguments[arguments.index("--port") + 1])
