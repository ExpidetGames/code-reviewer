# SPDX-License-Identifier: LicenseRef-Proprietary

"""The git side of an Implementer turn (#762): the safety core of the slice.

What the system does, and what the agent can and cannot:

* The runner (root) clones the base branch, `--depth 1`, into a bare **mirror** only it can enter
  (`/work/mirror.git`). The provider token is in the environment of that one git process and nowhere
  else: not in argv, a config file, a URL, the mirror or anything the agent's user can read.
* The agent works in `/work/repo`, a local clone of the mirror owned by the agent's user. It has no
  remote, no credential, the system identity and a new branch at the base tip.
* A `reference-transaction` hook (installed by the image, #761) keeps the agent on its branch and
  appends every tip update to a spool. It is an accident guard: `git -c core.hooksPath=/dev/null` or
  a hand-written ref gets around it.
* **The guarantee is the push.** From the mirror, as root: fetch the agent's branch without force,
  check that the tip still contains the start commit, push without force. A rewrite below what was
  already pushed makes the fetch refuse; the turn then ends `branch_violation` and the provider
  keeps the last good tip.
* Root never runs git with the agent's repository as working directory or git directory (it would
  run the `core.fsmonitor`, hooks and aliases the agent can write). `git status` and the leftover
  commit run as the agent's user. The mirror reads the agent's branch through `git upload-pack` that
  is itself run as the agent's user, so the config of the agent's repository is read by the agent's
  own rights and by nothing else.
"""

import os
import shlex
import shutil
import stat
import subprocess
import threading
import time
from collections.abc import Callable, Collection
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit

from ..job import JobError
from ..result import ErrorCode
from .git_process import (
    DEFAULT_TIMEOUT,
    MIN_GIT_VERSION,
    TRUSTED_PATH,
    GitProcess,
    Outcome,
    fail,
    parse_git_version,
    spawn_options,
    token_environment,
)
from .guard_files import (
    CONFIG_MODE,
    SPOOL_MODE,
    SpoolWatcher,
    guard_conf_text,
    system_gitconfig_text,
    write_file,
)

LEFTOVER_MESSAGE = "Implementer: uncommitted changes of the turn"
# The most often a batch of commits is pushed while the agent works (the final push is not held
# back).
PUSH_INTERVAL_SECONDS = 120.0
SELF_TEST_TIMEOUT = 180.0
# Reading the agent's tip happens every tick: a repository the agent made unreadable (a FIFO as
# `.git/HEAD`) must cost seconds, not the 600 s of a push.
TIP_TIMEOUT = 20.0
# What git prints when it refuses the agent's branch for what the branch is. Anything else a failed
# fetch prints (a timeout, a stale lock, an unreadable file, a full disk) says nothing about the
# agent's branch, and so must not end its turn.
_REFUSALS = (
    ("(non-fast-forward)", "the branch was rewritten, it is not a fast-forward of what was pushed"),
    ("non-commit object", "the branch does not point at a commit"),
    ("fsck error", "the branch has objects git refuses"),
    ("couldn't find remote ref", "the branch is gone"),
)
_PLAIN_FETCH = ("--no-tags", "--no-write-fetch-head")


@dataclass(frozen=True)
class AgentUser:
    """The unprivileged user the agent and its git processes run as (the engine user)."""

    uid: int
    gid: int


@dataclass(frozen=True)
class GitIdentity:
    """Who the agent's commits are by: `<product> Implementer`."""

    name: str
    email: str


@dataclass(frozen=True)
class WorkspaceSpec:
    """What a job names: the repository, the token that may write it and the two branches."""

    clone_url: str
    token: str
    base_branch: str
    branch: str


@dataclass(frozen=True)
class WorkspaceLayout:
    """Where things are. `work_dir` is the work volume, `run_dir` is under /run (the guard's
    configuration and spool), `guard_dir` holds the hook and the matrix (the image), `agent_home` is
    the agent's own home."""

    agent_home: Path
    work_dir: Path = Path("/work")
    run_dir: Path = Path("/run/code-reviewer")
    guard_dir: Path = Path("/opt/code-reviewer/guard")


class PushUnverified(JobError):
    """The agent's branch could not be looked at this time (git timed out, a lock, an unreadable
    repository). Nothing is known against the agent: the next push tries again."""

    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.RUNNER_ERROR, detail)


class PushOutcome(Enum):
    PUSHED = "pushed"
    UP_TO_DATE = "up_to_date"
    NOTHING_TO_PUSH = "nothing_to_push"


@dataclass(frozen=True)
class PushResult:
    outcome: PushOutcome
    # The tip the provider has after this call (None: nothing was ever pushed).
    head: str | None


def _invalid(detail: str) -> JobError:
    return fail(ErrorCode.IMPLEMENTER_CONFIG_INVALID, detail)


def _checked_url(url: str, schemes: Collection[str]) -> None:
    parts = urlsplit(url)
    if parts.scheme not in schemes:
        raise _invalid("the clone address must be an https address")
    if parts.scheme == "file":
        if not parts.path.startswith("/"):
            raise _invalid("the clone address is not a valid file address")
        return
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise _invalid("the clone address must not have credentials, a query or a fragment")


class GitWorkspace:
    """One turn's repository, guard and mirror. See the module text for the rules."""

    def __init__(
        self,
        spec: WorkspaceSpec,
        layout: WorkspaceLayout,
        agent: AgentUser,
        identity: GitIdentity,
        *,
        git: str = "git",
        path: str = TRUSTED_PATH,
        schemes: Collection[str] = ("https",),
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if agent.uid == 0 or agent.gid == 0:
            raise _invalid("the agent must not run as root")
        _checked_url(spec.clone_url, schemes)
        executable = shutil.which(git, path=path)
        if executable is None:
            raise fail(ErrorCode.SETUP_FAILED, "git is not installed")
        self.spec = spec
        self.layout = layout
        self.agent = agent
        self.identity = identity
        self.git = executable
        self._schemes = tuple(sorted(schemes))
        self._timeout = timeout
        self._path = ":".join(dict.fromkeys([str(Path(executable).parent), *path.split(":")]))
        self._process = GitProcess(executable, self._path, layout.run_dir, spec.token)
        self.mirror = layout.work_dir / "mirror.git"
        self.repo = layout.work_dir / "repo"
        self.spool_path = layout.run_dir / "spool"
        self.guard_conf_path = layout.run_dir / "guard.conf"
        self.system_config_path = layout.run_dir / "system.gitconfig"
        self._spool = SpoolWatcher(self.spool_path)
        self._start: str | None = None
        self._pushed: str | None = None
        self._poisoned = False
        self._names_checked = False
        # One look at the agent's branch and one push at a time (the loop's tick races the final
        # push); the mirror is only ever written under it.
        self._lock = threading.RLock()
        # How many times the agent's branch was fetched and checked (a test counts them).
        self.verifications = 0

    # -- what the caller needs -------------------------------------------------------------------

    @property
    def start_commit(self) -> str:
        if self._start is None:
            raise fail(ErrorCode.SETUP_FAILED, "the base branch is not cloned yet")
        return self._start

    @property
    def pushed_tip(self) -> str | None:
        """The tip the provider has (None until the first push)."""
        return self._pushed

    def agent_environment(self) -> dict[str, str]:
        """The environment of every process of the agent: the guard on, the identity set and no
        credential of any kind. The agent's engine and its tools get this one."""
        home = str(self.layout.agent_home)
        return {
            "PATH": self._path,
            "HOME": home,
            "GIT_CONFIG_SYSTEM": str(self.system_config_path),
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "CODE_REVIEWER_GUARD_CONF": str(self.guard_conf_path),
            "GIT_AUTHOR_NAME": self.identity.name,
            "GIT_AUTHOR_EMAIL": self.identity.email,
            "GIT_COMMITTER_NAME": self.identity.name,
            "GIT_COMMITTER_EMAIL": self.identity.email,
        }

    # -- the steps of a turn's set-up ------------------------------------------------------------

    def prepare(self, *, self_test: bool = True) -> None:
        """Everything before the agent starts: the self-test, the mirror, the agent's repository and
        the guard. Raises `JobError` with a stable code; nothing is left half done that a retry
        would trip over (the work volume is a new one per turn)."""
        self._check_names()
        if self_test:
            self.self_test()
        self.clone_mirror()
        self.create_agent_repository()
        self.install_guard()

    def self_test(self) -> None:
        """Prove the guard before the agent runs: git is new enough and the matrix of about thirty
        actions behaves as the agent's user. Any failure is `setup_failed`; a turn never runs
        unguarded."""
        version = parse_git_version(
            self._process.run(["--version"], env=self._process.base_environment("file")).stdout
        )
        if version is None:
            raise fail(ErrorCode.SETUP_FAILED, "the version of git cannot be read")
        if version < MIN_GIT_VERSION:
            wanted = ".".join(map(str, MIN_GIT_VERSION))
            raise fail(
                ErrorCode.SETUP_FAILED,
                f"git {'.'.join(map(str, version))} is older than {wanted}: the branch guard "
                "cannot see a switch of branch on it",
            )
        for name in ("reference-transaction", "guard_matrix.sh"):
            if not os.access(self.layout.guard_dir / name, os.X_OK):
                raise fail(ErrorCode.SETUP_FAILED, f"the guard file {name} is missing")
        if self._drops_privileges() and self._setpriv() is None:
            raise fail(ErrorCode.SETUP_FAILED, "setpriv is not installed")
        environment = {
            "PATH": self._path,
            "HOME": str(self.layout.agent_home),
            "TMPDIR": str(self.layout.agent_home),
            "GUARD_DIR": str(self.layout.guard_dir),
        }
        try:
            done = subprocess.run(
                [str(self.layout.guard_dir / "guard_matrix.sh")],
                cwd=self.layout.agent_home,
                env=environment,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=SELF_TEST_TIMEOUT,
                check=False,
                **spawn_options(self.agent.uid, self.agent.gid),
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise fail(
                ErrorCode.SETUP_FAILED, f"the guard matrix cannot run: {type(error).__name__}"
            ) from None
        if done.returncode != 0:
            lines = [
                line
                for line in (done.stdout + done.stderr).splitlines()
                if line.startswith(("FAIL", "guard_matrix:"))
            ] or (done.stdout + done.stderr).splitlines()[-5:]
            raise fail(
                ErrorCode.SETUP_FAILED,
                f"the guard matrix failed (status {done.returncode}): "
                + self._process.detail("\n".join(lines)),
            )

    def clone_mirror(self) -> None:
        """Fetch the base branch, depth 1, into the new bare mirror. The token is in this one
        process's environment."""
        self._check_names()
        self._prepare_directories()
        mirror = self.mirror
        mirror.mkdir(mode=0o700)
        os.chmod(mirror, 0o700)
        base = self.spec.base_branch
        init = self._root(
            ["init", "-q", "--bare", f"--initial-branch={base}", str(mirror)], protocols="file"
        )
        if init.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED, "the mirror cannot be created: " + self._detail(init)
            )
        fetched = self._root(
            [
                "--git-dir",
                str(mirror),
                "fetch",
                "--depth=1",
                *_PLAIN_FETCH,
                self.spec.clone_url,
                f"refs/heads/{base}:refs/heads/{base}",
            ],
            protocols=":".join(self._schemes),
            token=True,
        )
        if fetched.returncode != 0:
            code = (
                ErrorCode.BASE_BRANCH_NOT_FOUND
                if "couldn't find remote ref" in fetched.stderr
                else ErrorCode.CLONE_FAILED
            )
            raise fail(code, "the base branch cannot be cloned: " + self._detail(fetched))
        tip = self._root(
            ["--git-dir", str(mirror), "rev-parse", "--verify", f"refs/heads/{base}^{{commit}}"],
            protocols="file",
        )
        if tip.returncode != 0:
            raise fail(ErrorCode.CLONE_FAILED, "the cloned base branch has no commit")
        self._start = tip.stdout.strip()

    def create_agent_repository(self) -> None:
        """The agent's repository: a local clone of the mirror (no hard links, so nothing is shared
        with it), handed to the agent's user, without a remote, with the identity and the new branch
        at the base tip. The same path every turn."""
        start = self.start_commit
        base = self.spec.base_branch
        cloned = self._root(
            [
                "-c",
                "core.hooksPath=/dev/null",
                "clone",
                "-q",
                "--no-tags",
                "--single-branch",
                f"--branch={base}",
                "--template=",
                f"file://{self.mirror}",
                str(self.repo),
            ],
            protocols="file",
        )
        if cloned.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED,
                "the agent repository cannot be cloned: " + self._detail(cloned),
            )
        _hand_over(self.repo, self.agent)
        setup = (
            ["remote", "remove", "origin"],
            ["config", "user.name", self.identity.name],
            ["config", "user.email", self.identity.email],
            ["config", "commit.gpgsign", "false"],
            ["checkout", "-q", "-b", self.spec.branch],
        )
        environment = {**self.agent_environment(), "GIT_CONFIG_SYSTEM": "/dev/null"}
        for arguments in setup:
            done = self._as_agent(arguments, env=environment)
            if done.returncode != 0:
                raise fail(
                    ErrorCode.SETUP_FAILED,
                    f"git {arguments[0]} failed in the agent repository: "
                    + self._agent_detail(done),
                )
        head = self._as_agent(["rev-parse", "HEAD"], env=environment)
        if head.stdout.strip() != start:
            raise fail(ErrorCode.SETUP_FAILED, "the agent repository is not at the base tip")

    def install_guard(self) -> None:
        """Switch the guard on: the hook's configuration (branch, start commit, spool), the system
        git config of the agent's git and the spool. Written by root, readable by the agent."""
        _own_directory(self.layout.run_dir)
        write_file(
            self.guard_conf_path,
            guard_conf_text(
                branch=self.spec.branch,
                start=self.start_commit,
                spool=str(self.spool_path),
                repo=str(self.repo),
            ),
            CONFIG_MODE,
        )
        write_file(
            self.system_config_path,
            system_gitconfig_text(self.layout.guard_dir, [self.repo]),
            CONFIG_MODE,
        )
        write_file(self.spool_path, "", SPOOL_MODE)

    # -- the leftover API (as the agent's user) ---------------------------------------------------

    def dirty(self) -> bool:
        """Whether the working tree has changes, untracked files included. Runs as the agent."""
        done = self._as_agent(
            ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]
        )
        if done.returncode != 0:
            raise fail(ErrorCode.SETUP_FAILED, "git status failed: " + self._agent_detail(done))
        return bool(done.stdout)

    def commit_all(self, message: str = LEFTOVER_MESSAGE) -> str | None:
        """Commit everything with the fixed message, as the agent's user, through the guard. Returns
        the new tip, or None when there was nothing to commit."""
        added = self._as_agent(["add", "-A"])
        if added.returncode != 0:
            raise fail(ErrorCode.SETUP_FAILED, "git add failed: " + self._agent_detail(added))
        if self._as_agent(["diff", "--cached", "--quiet"]).returncode == 0:
            return None
        committed = self._as_agent(["commit", "-q", "-m", message])
        if committed.returncode != 0:
            raise fail(
                ErrorCode.SETUP_FAILED, "the commit failed: " + self._agent_detail(committed)
            )
        head = self._as_agent(["rev-parse", "HEAD"])
        return head.stdout.strip()

    def agent_tip(self) -> str | None:
        """The tip of the agent's branch, read the safe way (`ls-remote` against a `git upload-pack`
        run as the agent's user). None when it cannot be read within `TIP_TIMEOUT`; the push does
        its own check."""
        with self._lock:
            listed = self._root(
                [
                    "ls-remote",
                    f"--upload-pack={self._upload_pack()}",
                    str(self.repo),
                    f"refs/heads/{self.spec.branch}",
                ],
                protocols="file",
                timeout=min(self._timeout, TIP_TIMEOUT),
            )
        if listed.returncode != 0:
            return None
        for line in listed.stdout.splitlines():
            sha, _, name = line.partition("\t")
            if name == f"refs/heads/{self.spec.branch}" and len(sha) == 40:
                return sha
        return None

    def spool_signalled(self) -> bool:
        """Whether the spool has a tip update the runner has not looked at (a hint only)."""
        return self._spool.signalled()

    # -- the push ----------------------------------------------------------------------------------

    def push(self) -> PushResult:
        """Fetch the agent's branch into the mirror without force, check that it still contains
        the start commit and was committed by the system identity, and push it from the mirror
        without force.

        Only a refusal of the branch itself (a rewrite, an object that is no commit, a bad object,
        a commit by another committer, a branch without the start commit) ends the turn for good;
        a look that failed for another reason raises `PushUnverified` and the next call tries
        again."""
        with self._lock:
            return self._push()

    def _push(self) -> PushResult:
        if self._poisoned:
            raise fail(
                ErrorCode.BRANCH_VIOLATION, "the agent's branch was rewritten earlier in this turn"
            )
        self.verifications += 1
        ref = f"refs/heads/{self.spec.branch}"
        self._clear_stale_locks()
        previous = self._mirror_tip(ref)
        fetched = self._root(
            [
                "--git-dir",
                str(self.mirror),
                "-c",
                "fetch.fsckObjects=true",
                "fetch",
                *_PLAIN_FETCH,
                f"--upload-pack={self._upload_pack()}",
                str(self.repo),
                f"{ref}:{ref}",
            ],
            protocols="file",
        )
        if fetched.returncode != 0:
            for marker, reason in _REFUSALS:
                if marker in fetched.stderr:
                    self._poisoned = True
                    raise fail(
                        ErrorCode.BRANCH_VIOLATION,
                        f"the agent's branch cannot be taken over without force: {reason}",
                    )
            raise PushUnverified(
                f"the agent's branch could not be fetched (git fetch, status {fetched.returncode})"
            )
        tip = self._mirror_tip(ref)
        if tip is None:
            self._poisoned = True
            raise fail(ErrorCode.BRANCH_VIOLATION, "the agent's branch has no commit")
        self._check_tip(ref, tip, previous)
        if tip == self._pushed:
            return PushResult(PushOutcome.UP_TO_DATE, self._pushed)
        if tip == self.start_commit and self._pushed is None:
            return PushResult(PushOutcome.NOTHING_TO_PUSH, None)
        return self._push_from_mirror(ref, tip)

    def _check_tip(self, ref: str, tip: str, previous: str | None) -> None:
        """The fetched tip contains the start commit and every commit since was committed by the
        system identity. Only the committer is checked: `git cherry-pick`, `git am` and a merge keep
        the foreign author of a legitimate commit, while the committer is always the agent's
        environment. A forged author stays possible and is visible, because the committer of the
        same commit shows the system. A tip that does not pass is taken out of the mirror again."""
        contains_start = self._root(
            ["--git-dir", str(self.mirror), "merge-base", "--is-ancestor", self.start_commit, tip],
            protocols="file",
        )
        if contains_start.returncode not in (0, 1):
            raise PushUnverified("the start commit could not be looked for (git merge-base)")
        if contains_start.returncode == 1:
            self._reject(
                ref, previous, "the agent's branch no longer contains the commit it started from"
            )
        listed = self._root(
            [
                "--git-dir",
                str(self.mirror),
                "log",
                "--no-show-signature",
                "--format=%H%x00%cn%x00%ce",
                f"{self.start_commit}..{tip}",
            ],
            protocols="file",
        )
        if listed.returncode != 0:
            raise PushUnverified("the commits of the branch could not be listed (git log)")
        system = (self.identity.name, self.identity.email)
        for line in listed.stdout.splitlines():
            sha, _, people = line.partition("\0")
            if tuple(people.split("\0")) != system:
                self._reject(
                    ref, previous, f"commit {sha[:12]} was not committed by the system identity"
                )

    def _reject(self, ref: str, previous: str | None, reason: str) -> NoReturn:
        self._restore(ref, previous)
        self._poisoned = True
        raise fail(ErrorCode.BRANCH_VIOLATION, reason)

    def _push_from_mirror(self, ref: str, tip: str) -> PushResult:
        pushed = self._root(
            [
                "--git-dir",
                str(self.mirror),
                "push",
                "--porcelain",
                self.spec.clone_url,
                f"{ref}:{ref}",
            ],
            protocols=":".join(self._schemes),
            token=True,
        )
        if pushed.returncode != 0:
            refused = [line for line in pushed.stdout.splitlines() if line.startswith("!")]
            detail = self._detail(pushed)
            first = self._pushed is None
            if any("[rejected]" in line for line in refused) and first:
                raise fail(
                    ErrorCode.BRANCH_EXISTS,
                    "the branch exists on the provider with other history: " + detail,
                )
            raise fail(ErrorCode.PUSH_REJECTED, "the provider did not accept the push: " + detail)
        self._pushed = tip
        return PushResult(PushOutcome.PUSHED, tip)

    # -- internals ------------------------------------------------------------------------

    def _check_names(self) -> None:
        """The branch names are used in refspecs: git itself says whether they are fine."""
        if self._names_checked:
            return
        base, branch = self.spec.base_branch, self.spec.branch
        if branch == base or branch == "HEAD" or branch.startswith("-") or base.startswith("-"):
            raise _invalid("the branch must be a new name that git accepts")
        for name in (base, branch):
            done = self._root(["check-ref-format", f"refs/heads/{name}"], protocols="file")
            if done.returncode != 0:
                raise _invalid("a branch name is not one git accepts")
        self._names_checked = True

    def _prepare_directories(self) -> None:
        for directory in (self.layout.work_dir, self.layout.run_dir):
            _own_directory(directory)
        for existing in (self.mirror, self.repo):
            if existing.exists() or existing.is_symlink():
                raise fail(
                    ErrorCode.SETUP_FAILED, f"{existing.name} exists already in the work directory"
                )

    def _clear_stale_locks(self) -> None:
        """Remove the `.lock` files in the mirror. Only the runner writes the mirror, and only under
        `self._lock`, so a lock found here belongs to a git that was killed (a timeout) and would
        refuse every later fetch."""
        for directory, _, files in os.walk(self.mirror, followlinks=False):
            for name in files:
                if name.endswith(".lock"):
                    Path(directory, name).unlink(missing_ok=True)

    def _drops_privileges(self) -> bool:
        return bool(spawn_options(self.agent.uid, self.agent.gid))

    def _setpriv(self) -> str | None:
        return shutil.which("setpriv", path=TRUSTED_PATH)

    def _upload_pack(self) -> str:
        """The command git runs on the far side of a local fetch. It reads the agent's repository,
        so it runs as the agent's user: that repository's config is read with the agent's rights."""
        command = [self.git, "upload-pack"]
        if self._drops_privileges():
            setpriv = self._setpriv()
            if setpriv is None:
                raise fail(ErrorCode.SETUP_FAILED, "setpriv is not installed")
            command = [
                setpriv,
                f"--reuid={self.agent.uid}",
                f"--regid={self.agent.gid}",
                "--clear-groups",
                "--no-new-privs",
                *command,
            ]
        return " ".join(shlex.quote(part) for part in command)

    def _root(
        self,
        args: list[str],
        *,
        protocols: str,
        token: bool = False,
        timeout: float | None = None,
    ) -> Outcome:
        """Git as the runner, never with the agent's repository as its directory."""
        environment = self._process.base_environment(protocols)
        if token:
            environment.update(token_environment(self.spec.token))
        return self._process.run(args, env=environment, timeout=timeout or self._timeout)

    def _as_agent(self, args: list[str], *, env: dict[str, str] | None = None) -> Outcome:
        return self._process.run(
            args,
            env=env or self.agent_environment(),
            cwd=self.repo,
            spawn=spawn_options(self.agent.uid, self.agent.gid),
            timeout=self._timeout,
        )

    def _mirror_tip(self, ref: str) -> str | None:
        done = self._root(
            ["--git-dir", str(self.mirror), "rev-parse", "-q", "--verify", ref], protocols="file"
        )
        return done.stdout.strip() or None if done.returncode == 0 else None

    def _restore(self, ref: str, previous: str | None) -> None:
        """Put the mirror's branch back to what was pushed (or remove it)."""
        arguments = ["update-ref", "-d", ref] if previous is None else ["update-ref", ref, previous]
        self._root(["--git-dir", str(self.mirror), *arguments], protocols="file")

    def _detail(self, outcome: Outcome) -> str:
        """Git's output on the runner's own data (the mirror, the provider)."""
        return self._process.detail(outcome.stderr or outcome.stdout)

    def _agent_detail(self, outcome: Outcome) -> str:
        """The result of a git command on the agent's repository: what the agent can make git print
        does not travel (see `GitProcess.agent_detail`), only the status and a guard denial."""
        denial = self._process.agent_detail(outcome.stderr + outcome.stdout)
        status = f"status {outcome.returncode}"
        return f"{status}: {denial}" if denial else status


def _own_directory(path: Path) -> None:
    """Make sure a directory the guard's files and the agent's tree live in is the runner's. A new
    one is created. An existing one is opened without following a link and judged from that
    descriptor (no gap between the look and the chmod): a plain directory of the runner's user
    that no one else can write. Only then is it made enterable for the agent."""
    path.parent.mkdir(parents=True, exist_ok=True)
    created = True
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        created = False
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise fail(
            ErrorCode.SETUP_FAILED, f"{path.name} is not a plain directory (a link or a file)"
        ) from None
    try:
        status = os.fstat(descriptor)
        if not created and status.st_uid != os.geteuid():
            raise fail(ErrorCode.SETUP_FAILED, f"{path.name} does not belong to the runner")
        if not created and status.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise fail(ErrorCode.SETUP_FAILED, f"{path.name} can be written by others")
        os.fchmod(descriptor, 0o755)
    finally:
        os.close(descriptor)


def _hand_over(root: Path, agent: AgentUser) -> None:
    """Make the freshly cloned tree the agent's, without following a link."""
    os.lchown(root, agent.uid, agent.gid)
    for directory, names, files in os.walk(root, followlinks=False):
        for name in [*names, *files]:
            os.lchown(os.path.join(directory, name), agent.uid, agent.gid)


class PushLoop:
    """When to push while the agent works. The caller ticks it every couple of seconds.

    A push is due when the spool got a line or the branch moved (the poll finds what the hook's hint
    missed); due pushes are batched to at most one per `interval`, except the final one. A look at
    the branch that failed for a reason that is not the agent's (`PushUnverified`) is tried again
    at the next tick; the final push raises it."""

    def __init__(
        self,
        workspace: GitWorkspace,
        *,
        interval: float = PUSH_INTERVAL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._workspace = workspace
        self._interval = interval
        self._clock = clock
        self._seen = workspace.start_commit
        self._pending = False
        self._last: float | None = None

    def tick(self) -> PushResult | None:
        if self._workspace.spool_signalled():
            self._pending = True
        tip = self._workspace.agent_tip()
        if tip is not None and tip != self._seen:
            self._seen = tip
            self._pending = True
        if not self._pending:
            return None
        now = self._clock()
        if self._last is not None and now - self._last < self._interval:
            return None
        try:
            result = self._workspace.push()
        except PushUnverified:
            return None  # nothing is known against the agent: the next tick looks again
        self._pending = False
        self._last = now
        return result

    def finish(self) -> PushResult:
        """The last push of the turn, at once."""
        result = self._workspace.push()
        self._pending = False
        self._last = self._clock()
        return result
