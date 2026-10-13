# SPDX-License-Identifier: Apache-2.0
"""Root-owned read-only exports and exclusive unprivileged job identities.

This prepares a launch boundary. #197 owns the engine/proxy/whole-process supervision and
#202 owns the container user and network self-check. Nothing here activates that capability.
"""

import fcntl
import os
import pwd
import shutil
import stat
import subprocess
import tempfile
import time
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from code_reviewer_runner.job import Job
from code_reviewer_runner.job_loop.process import JOB_WORKDIR_PREFIX
from code_reviewer_runner.result import ErrorCode

from .checkout import PreparedContent, prepare_job_content
from .limits import DEFAULT_LIMITS, Budget, CheckoutError, Limits

_DISCOVERY = (
    ".opencode",
    "opencode.json",
    "opencode.jsonc",
    "tui.json",
    "tui.jsonc",
    ".claude",
    ".agents",
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md",
)
_RUNTIME_RESERVATION_BYTES = 64 * 1024
_LEASES = Path("/run/code-reviewer-checkout-users")


def _refuse() -> CheckoutError:
    return CheckoutError(ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED)


@dataclass(frozen=True)
class AgentIdentity:
    uid: int
    gid: int

    def validate(self) -> None:
        if os.geteuid() != 0 or self.uid <= 0 or self.gid <= 0:
            raise _refuse()
        try:
            user = pwd.getpwuid(self.uid)
        except KeyError:
            raise _refuse() from None
        if user.pw_gid != self.gid:
            raise _refuse()


@dataclass
class PreparedJob:
    root: Path
    directory: Path
    runtime: Path
    identity: AgentIdentity
    environment: dict[str, str] = field(default_factory=lambda: {})
    sealed: bool = False

    def seal(self, content: PreparedContent) -> None:
        """No engine may consume a private intermediate. Seal once, after successful prep."""
        if self.sealed or content.root != self.directory:
            raise _refuse()
        _clean_ancestors(content.export.parent)
        _read_only(self.directory, self.identity.gid)
        os.chown(self.root, 0, self.identity.gid)
        os.chmod(self.root, 0o710)
        _verify_effective_access(self, content.deadline)
        self.sealed = True


_ACCESS_PROBE = r"""
import os, pathlib, sys
root, export, private, parent = map(pathlib.Path, sys.argv[1:])
assert os.getuid() != 0
def unreadable(error):
    raise error
for directory, dirs, files in os.walk(export, onerror=unreadable):
    for name in files:
        path = pathlib.Path(directory, name)
        assert not path.is_symlink()
        with path.open("rb") as stream:
            stream.read(1)
        try:
            fd = os.open(path, os.O_WRONLY)
        except PermissionError:
            pass
        else:
            os.close(fd)
            raise AssertionError("writable file")
    attempt = pathlib.Path(directory, ".write-probe")
    try:
        fd = os.open(attempt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except PermissionError:
        pass
    else:
        os.close(fd)
        attempt.unlink()
        raise AssertionError("writable directory")
for path in (private, parent):
    try:
        with path.open("rb") as stream:
            stream.read(1)
    except PermissionError:
        pass
    else:
        raise AssertionError("readable private state")
"""


def _verify_effective_access(job: PreparedJob, deadline: float) -> None:
    remaining = min(5, deadline - time.monotonic())
    if remaining <= 0:
        raise CheckoutError(ErrorCode.TIMEOUT)
    executable = shutil.which("python3", path="/usr/local/bin:/usr/bin:/bin")
    if executable is None:
        raise _refuse()
    private = job.root / ".private-probe"
    descriptor = os.open(private, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        outcome = subprocess.run(
            [
                executable,
                "-I",
                "-c",
                _ACCESS_PROBE,
                str(job.root),
                str(job.directory),
                str(private),
                f"/proc/{os.getpid()}/environ",
            ],
            env=job.environment,
            user=job.identity.uid,
            group=job.identity.gid,
            extra_groups=(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=remaining,
            check=False,
        )
        if outcome.returncode != 0:
            raise _refuse()
    except (OSError, subprocess.TimeoutExpired):
        if time.monotonic() >= deadline:
            raise CheckoutError(ErrorCode.TIMEOUT) from None
        raise _refuse() from None
    finally:
        private.unlink()


def _trusted_directory(path: Path, mode: int) -> None:
    if not path.exists():
        path.mkdir(mode=mode)
    info = path.lstat()
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != 0
        or info.st_mode & 0o022
        or info.st_mode & stat.S_ISVTX
    ):
        raise _refuse()
    os.chmod(path, mode)


def _clean_ancestors(path: Path) -> None:
    for directory in (path, *path.parents):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0:
            raise _refuse()
        # Only a root-owned sticky system temp ancestor may be writable by other users.
        if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise _refuse()
        for name in _DISCOVERY:
            if os.path.lexists(directory / name):
                raise _refuse()
    # No managed discovery payload may override the trusted config. Do not read its contents.
    if os.path.lexists("/etc/opencode"):
        raise _refuse()


def _read_only(path: Path, gid: int) -> None:
    info = path.lstat()
    if info.st_uid != 0 or stat.S_ISLNK(info.st_mode):
        raise _refuse()
    if stat.S_ISREG(info.st_mode):
        if info.st_nlink != 1:
            raise _refuse()
        os.chown(path, 0, gid)
        os.chmod(path, 0o440)
        return
    if not stat.S_ISDIR(info.st_mode):
        raise _refuse()
    for child in path.iterdir():
        _read_only(child, gid)
    os.chown(path, 0, gid)
    os.chmod(path, 0o550)


def _nothing() -> None:
    return None


@contextmanager
def prepared_job(
    parent: Path, identity: AgentIdentity, *, on_lease: Callable[[], None] = _nothing
) -> Generator[PreparedJob]:
    """One root-supervised lifetime; the caller keeps it open through launch and completion.

    A uid/gid is exclusive across all jobs in the container. Parallel slots require distinct
    users AND primary groups. The shared lock is outside agent access and is not a Git cache.
    The caller must terminate its engine process group before leaving this lifetime; trusted
    preparation owns no engine process. Failures/cancellation/signals must unwind this context.

    `on_lease` runs once the user is leased and before anything of this job exists: whatever an
    earlier job left running as that user is ended there, before it could read this job's files.
    """
    identity.validate()
    _clean_ancestors(parent.parent)
    _trusted_directory(parent, 0o711)
    _clean_ancestors(parent)
    _trusted_directory(_LEASES, 0o700)
    # Reserve both uid and gid: distinct users sharing a group could otherwise read each other.
    leases: list[int] = []
    root: Path | None = None
    try:
        for name in (f"uid-{identity.uid}", f"gid-{identity.gid}"):
            descriptor = os.open(_LEASES / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            leases.append(descriptor)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise _refuse() from None
        on_lease()
        root = Path(tempfile.mkdtemp(prefix="job-", dir=parent))
        runtime = root / "runtime"
        runtime.mkdir(mode=0o700)
        os.chown(runtime, identity.uid, identity.gid)
        environment = {"PATH": "/usr/local/bin:/usr/bin:/bin"}
        for key, name in (
            ("HOME", "home"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_STATE_HOME", "state"),
            ("TMPDIR", "scratch"),
        ):
            directory = runtime / name
            directory.mkdir(mode=0o700)
            os.chown(directory, identity.uid, identity.gid)
            environment[key] = str(directory)
        yield PreparedJob(root, root / "prepared", runtime, identity, environment)
    finally:
        if root is not None:
            # Runtime may have malicious links; rmtree uses fd-based symlink-attack resistance.
            shutil.rmtree(root)
        for descriptor in reversed(leases):
            os.close(descriptor)


@contextmanager
def prepared_checkout(
    job: Job,
    parent: Path,
    identity: AgentIdentity,
    *,
    limits: Limits = DEFAULT_LIMITS,
    cancelled: Callable[[], bool] = lambda: False,
    metadata: str = "",
    prior_state: str = "",
    content_for: Callable[..., PreparedContent] = prepare_job_content,
    on_lease: Callable[[], None] = _nothing,
) -> Generator[tuple[PreparedContent, PreparedJob]]:
    """The root-supervised integration seam for #197; keep open until all owned processes end.

    Parent MUST be within the job loop's per-process working directory. Its existing collector
    deletes that directory after SIGKILL too, when Python cannot unwind a context manager.
    """
    budget = Budget(limits, cancelled)
    # Cover the outer job/root, empty runtime directories, identity leases and access probe.
    # Reserve before creating any of them; retain the same deadline through sealing.
    budget.charge(_RUNTIME_RESERVATION_BYTES)
    working_directory = Path.cwd().resolve()
    original = working_directory.stat()
    if (
        not working_directory.name.startswith(JOB_WORKDIR_PREFIX)
        or original.st_uid != 0
        or stat.S_IMODE(original.st_mode) != 0o700
    ):
        raise _refuse()
    parent = parent.resolve()
    if not parent.is_relative_to(working_directory):
        raise _refuse()
    with prepared_job(parent, identity, on_lease=on_lease) as lifetime:
        try:
            # The supervisor's mkdtemp starts at 0700. Grant only the leased job group
            # traversal through this owned working directory, without directory listing.
            os.chown(working_directory, 0, identity.gid)
            os.chmod(working_directory, 0o710)
            content = content_for(
                job,
                lifetime.directory,
                limits=limits,
                cancelled=cancelled,
                metadata=metadata,
                prior_state=prior_state,
                budget=budget,
            )
            lifetime.seal(content)
            yield content, lifetime
        finally:
            os.chown(working_directory, 0, original.st_gid)
            os.chmod(working_directory, stat.S_IMODE(original.st_mode))
