# SPDX-License-Identifier: Apache-2.0

"""The support code of the native provider engine tests (#546) must not leave a process behind.

`opencode_native._Engine` starts `opencode serve` in its constructor and waits for it to be healthy.
A constructor that raises leaves no `with` block to stop the process, so the engine has to stop it
itself, or an `opencode serve` is orphaned on the machine that ran the test, for good.
"""

import contextlib
import os
import signal
import subprocess
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
