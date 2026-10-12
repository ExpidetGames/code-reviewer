# SPDX-License-Identifier: Apache-2.0

"""Starts the real job entry point (`code-reviewer-run-job`) as a process, against the fakes.

The runner reads the job from stdin and prints one line of JSON. The process gets a minimal
environment of its own, like the runner loop gives it: a home and a working directory under the
test's temporary directory, and nothing of the developer's environment. `connect_guard/` is put on
its PYTHONPATH: it records every connection and refuses everything but loopback.
"""

import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import canned
from fake_github import BOT_LOGIN, FakeGithub
from fake_llm import FakeLlm

API_KEY = "dummy-openrouter-key-0123456789"
MODEL = "test/fake-model"
GUARD = Path(__file__).parent / "connect_guard"
ENTRY_POINT = Path(sys.executable).parent / "code-reviewer-run-job"
# The same entry point with the identity patch replaced by a no-op (the control run of the spike,
# scripts/manual_review.py --no-identity-patch): PR-Agent then asks GitHub who it is.
WITHOUT_IDENTITY_PATCH = [
    sys.executable,
    "-c",
    "import sys; from code_reviewer_runner import runner; "
    "runner.apply_identity_patch = lambda login: (lambda: None); sys.exit(runner.main([]))",
]
# tiktoken names its cache file after the hash of the URL it downloads from.
_O200K_URL = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"


def bpe_cache_directory() -> Path:
    """The directory tiktoken caches encodings in: where the job process will look."""
    for name in ("TIKTOKEN_CACHE_DIR", "DATA_GYM_CACHE_DIR"):
        if os.environ.get(name):
            return Path(os.environ[name])
    return Path(tempfile.gettempdir()) / "data-gym-cache"


def bpe_cache_file() -> Path:
    return bpe_cache_directory() / hashlib.sha1(_O200K_URL.encode()).hexdigest()


def visible_text(body: str) -> str:
    """A comment as a reader sees it: without the hidden HTML comments (markers, review state)."""
    return re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)


def default_replies() -> dict[str, str]:
    return {"review": canned.review()}


@dataclass
class Outcome:
    returncode: int
    stdout: str
    stderr: str
    workdir: Path
    home: Path
    connect_log: Path
    argv: list[str]

    @property
    def result(self) -> dict[str, Any]:
        """The one line of JSON on stdout."""
        lines = self.stdout.splitlines()
        assert len(lines) == 1, f"stdout must hold exactly one line, got: {self.stdout!r}"
        parsed: dict[str, Any] = json.loads(lines[0])
        return parsed

    @property
    def connections(self) -> list[dict[str, Any]]:
        if not self.connect_log.exists():
            return []
        return [json.loads(line) for line in self.connect_log.read_text().splitlines()]

    def files(self) -> dict[str, bytes]:
        """Every file the job left behind, by path relative to its home (the working directory and
        the temporary directory are inside it)."""
        return {
            str(path.relative_to(self.home)): path.read_bytes()
            for path in sorted(self.home.rglob("*"))
            if path.is_file()
        }


class Canary:
    """A loopback listener that stands for a host nothing may talk to: it counts connections."""

    def __init__(self) -> None:
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self._lock = threading.Lock()
        self.connections = 0
        self._thread = threading.Thread(target=self._accept, daemon=True)
        self._thread.start()

    @property
    def port(self) -> int:
        return int(self._listener.getsockname()[1])

    def _accept(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            with self._lock:
                self.connections += 1
            connection.close()

    def close(self) -> None:
        self._listener.close()
        self._thread.join(timeout=5)


class JobProcess:
    """A job that was started and has not finished yet."""

    def __init__(
        self,
        process: "subprocess.Popen[str]",
        workdir: Path,
        home: Path,
        log: Path,
        argv: list[str],
    ) -> None:
        self.process = process
        self.workdir = workdir
        self.home = home
        self.connect_log = log
        self.argv = argv

    @property
    def pid(self) -> int:
        return self.process.pid

    def command_line(self) -> str:
        """The command line of the running process, as `ps` shows it to anybody on the machine."""
        done = subprocess.run(
            ["ps", "-o", "args=", "-p", str(self.pid)],
            capture_output=True,
            text=True,
            check=False,
        )
        return done.stdout

    def environment_text(self) -> str:
        """The environment of the running process as `ps` shows it (`ps eww`)."""
        done = subprocess.run(
            ["ps", "eww", "-p", str(self.pid)], capture_output=True, text=True, check=False
        )
        return done.stdout

    def is_gone(self) -> bool:
        try:
            os.kill(self.pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        return False

    def kill(self) -> None:
        """End the process if it still runs, so a failing test leaves nothing behind."""
        if self.process.poll() is None:
            self.process.kill()
            self.process.communicate()

    def finish(self, stdin: str, timeout: float = 150) -> Outcome:
        try:
            stdout, stderr = self.process.communicate(stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            self.kill()
            raise
        return Outcome(
            self.process.returncode,
            stdout,
            stderr,
            self.workdir,
            self.home,
            self.connect_log,
            self.argv,
        )


@dataclass
class Engine:
    """Everything one test needs: the two fakes and a way to run jobs against them."""

    github: FakeGithub
    llm: FakeLlm
    tmp_path: Path
    _runs: int = 0
    _started: list["JobProcess"] = field(default_factory=lambda: [])

    def cleanup(self) -> None:
        """Kill every job process that is still running (called when the test is over)."""
        for job in self._started:
            job.kill()

    def job(
        self,
        command: str = "review",
        env: dict[str, str] | None = None,
        **overrides: Any,
    ) -> dict[str, Any]:
        job: dict[str, Any] = {
            "prUrl": self.github.pr_url,
            "command": command,
            "git": {
                "provider": "github",
                "baseUrl": self.github.base_url,
                "token": self.github.token,
                "botLogin": BOT_LOGIN,
            },
            "llm": {
                "provider": "openrouter",
                "model": MODEL,
                "apiKey": API_KEY,
                "baseUrl": self.llm.base_url,
                "maxTokens": 32000,
            },
        }
        if env is not None:
            job["env"] = env
        job.update(overrides)
        return job

    def start(
        self, extra_env: dict[str, str] | None = None, identity_patch: bool = True
    ) -> JobProcess:
        """Start a job process in a fresh home and working directory of its own."""
        self._runs += 1
        home = self.tmp_path / f"run-{self._runs}"
        workdir = home / "work"
        workdir.mkdir(parents=True)
        temporary = home / "tmp"
        temporary.mkdir()
        log = self.tmp_path / f"connections-{self._runs}.jsonl"
        environment = {
            "PATH": os.environ["PATH"],
            "HOME": str(home),
            "LANG": "C.UTF-8",
            "TMPDIR": str(temporary),
            "PYTHONPATH": str(GUARD),
            "ENGINE_CONNECT_LOG": str(log),
            "TIKTOKEN_CACHE_DIR": str(bpe_cache_directory()),
            **(extra_env or {}),
        }
        argv = [str(ENTRY_POINT)] if identity_patch else list(WITHOUT_IDENTITY_PATCH)
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=workdir,
            env=environment,
        )
        job = JobProcess(process, workdir, home, log, argv)
        self._started.append(job)
        return job

    def run(
        self,
        command: str = "review",
        *,
        job: dict[str, Any] | str | None = None,
        extra_env: dict[str, str] | None = None,
        identity_patch: bool = True,
        timeout: float = 150,
        **job_options: Any,
    ) -> Outcome:
        """Run a job to its end. `job_options` go to `job()`; `job` replaces it altogether."""
        started = self.start(extra_env, identity_patch)
        body = job if job is not None else self.job(command, **job_options)
        return started.finish(body if isinstance(body, str) else json.dumps(body), timeout)


def sent_to_fakes(github: FakeGithub, llm: FakeLlm) -> str:
    """Everything the job put into requests to the fakes, except the Authorization headers, which
    carry the credentials by design: bodies, paths and queries of both."""
    parts = [json.dumps(request.body) for request in llm.requests]
    parts += [request.path for request in llm.requests]
    parts += [request.body.decode(errors="replace") for request in github.requests]
    parts += [f"{request.path}?{json.dumps(request.query)}" for request in github.requests]
    return "\n".join(parts)


def credentials_travel_only_in_headers(github: FakeGithub, llm: FakeLlm) -> bool:
    """The LLM got the LLM key as a bearer token and nothing else, GitHub got the token."""
    llm_ok = all(request.authorization == f"Bearer {API_KEY}" for request in llm.requests)
    github_ok = all(
        request.authorization.split(" ")[0] in ("token", "Bearer")
        and request.authorization.split(" ")[-1] == github.token
        for request in github.requests
    )
    return llm_ok and github_ok
