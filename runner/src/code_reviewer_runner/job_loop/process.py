# SPDX-License-Identifier: Apache-2.0

"""One process per job: start it, bound what it can write, and end it together with its children.

The job goes in on stdin (never in the arguments, never in the environment), the result comes out
as the last line on stdout, diagnostics on stderr. Both streams are read continuously and only the
newest bytes are kept, so a process that writes hundreds of megabytes cannot grow the runner's
memory. The process is the leader of its own process group: ending a job ends the group, so a
helper the process started cannot outlive it.
"""

import asyncio
import contextlib
import os
import shutil
import signal
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

# The result line of a job is small (a log tail of 4 KB and a few numbers). Anything above this
# is not a result.
STDOUT_KEEP_BYTES = 256 * 1024
STDERR_KEEP_BYTES = 64 * 1024
_READ_CHUNK = 64 * 1024
# After the leader has exited, a helper that keeps a pipe open must not hold the job up.
_DRAIN_SECONDS = 2.0


class StreamTail:
    """The newest `keep` bytes of a stream, in bounded memory."""

    def __init__(self, keep: int) -> None:
        self._keep = keep
        self._buffer = bytearray()
        self.total = 0
        self.peak = 0

    def add(self, chunk: bytes) -> None:
        self.total += len(chunk)
        self._buffer += chunk
        if len(self._buffer) > 2 * self._keep:
            del self._buffer[: len(self._buffer) - self._keep]
        self.peak = max(self.peak, len(self._buffer))

    def value(self) -> bytes:
        return bytes(self._buffer[-self._keep :])

    @property
    def truncated(self) -> bool:
        return self.total > self._keep


@dataclass(frozen=True)
class ProcessSpec:
    argv: tuple[str, ...]
    env: Mapping[str, str]
    stdin: bytes


@dataclass(frozen=True)
class ProcessOutcome:
    # The exit code; negative means the signal that ended the process.
    exit_code: int
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


class RunningProcess(Protocol):
    async def wait(self) -> ProcessOutcome: ...

    async def terminate(self) -> None:
        """End the process and everything it started: SIGTERM first, SIGKILL after the grace."""
        ...


class ProcessLauncher(Protocol):
    async def start(self, spec: ProcessSpec) -> RunningProcess: ...


def _kill_group(pgid: int, sig: int) -> bool:
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError):
        return False
    return True


class _SubprocessJob:
    def __init__(
        self,
        process: asyncio.subprocess.Process,
        stdin: bytes,
        workdir: Path,
        terminate_grace: float,
    ) -> None:
        self._process = process
        self._workdir = workdir
        self._terminate_grace = terminate_grace
        self._stdout = StreamTail(STDOUT_KEEP_BYTES)
        self._stderr = StreamTail(STDERR_KEEP_BYTES)
        self._readers = [
            asyncio.create_task(self._write_stdin(stdin)),
            asyncio.create_task(self._read(process.stdout, self._stdout)),
            asyncio.create_task(self._read(process.stderr, self._stderr)),
        ]
        self._collected = asyncio.create_task(self._collect())

    @property
    def streams(self) -> tuple[StreamTail, StreamTail]:
        return self._stdout, self._stderr

    async def _write_stdin(self, data: bytes) -> None:
        stream = self._process.stdin
        if stream is None:
            return
        try:
            stream.write(data)
            await stream.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the process ended before it read the job; its exit code says what happened
        finally:
            with contextlib.suppress(Exception):
                stream.close()

    @staticmethod
    async def _read(stream: asyncio.StreamReader | None, tail: StreamTail) -> None:
        if stream is None:
            return
        while chunk := await stream.read(_READ_CHUNK):
            tail.add(chunk)

    async def _collect(self) -> ProcessOutcome:
        try:
            exit_code = await self._process.wait()
            # The leader is gone; whatever is left in its group is a helper nobody waits for.
            _kill_group(self._process.pid, signal.SIGKILL)
            _, pending = await asyncio.wait(self._readers, timeout=_DRAIN_SECONDS)
            for task in pending:
                task.cancel()
            await asyncio.gather(*self._readers, return_exceptions=True)
        finally:
            shutil.rmtree(self._workdir, ignore_errors=True)
        return ProcessOutcome(
            exit_code=exit_code,
            stdout=self._stdout.value(),
            stderr=self._stderr.value(),
            stdout_truncated=self._stdout.truncated,
            stderr_truncated=self._stderr.truncated,
        )

    async def wait(self) -> ProcessOutcome:
        return await asyncio.shield(self._collected)

    async def terminate(self) -> None:
        pgid = self._process.pid
        if self._process.returncode is None:
            _kill_group(pgid, signal.SIGTERM)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._process.wait(), self._terminate_grace)
        # Also after a clean exit of the leader: a helper that ignores SIGTERM goes too.
        _kill_group(pgid, signal.SIGKILL)
        await self.wait()


class SubprocessLauncher:
    def __init__(self, terminate_grace: float = 5.0) -> None:
        self._terminate_grace = terminate_grace

    async def start(self, spec: ProcessSpec) -> RunningProcess:
        # A directory of its own per job: PR-Agent reads `[tool.pr-agent]` from a pyproject.toml in
        # its working directory, so that directory must hold nothing the runner did not put there.
        workdir = Path(tempfile.mkdtemp(prefix="cr-job-"))
        try:
            process = await asyncio.create_subprocess_exec(
                *spec.argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=dict(spec.env),
                cwd=workdir,
                start_new_session=True,
            )
        except BaseException:
            shutil.rmtree(workdir, ignore_errors=True)
            raise
        return _SubprocessJob(process, spec.stdin, workdir, self._terminate_grace)
