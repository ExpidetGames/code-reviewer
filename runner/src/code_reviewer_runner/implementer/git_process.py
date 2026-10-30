# SPDX-License-Identifier: LicenseRef-Proprietary

"""Running git for the Implementer's workspace (#762): a closed environment, the token only in the
environment of the one process that talks to the provider, and errors that never carry it.

Two kinds of caller. The *runner* (root) runs git on the mirror it owns and, to talk to the
provider, with the token. The *agent's user* runs git in the agent's repository. Root never runs
git with the agent's repository as working directory or git directory: that would run the
`core.fsmonitor`, hooks and aliases the agent can write.
"""

import base64
import contextlib
import os
import re
import signal
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..job import JobError
from ..redaction import Redactor
from ..result import ErrorCode

TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
# The guard hook is blind to a change of branch on older git (spike section 2.2): the self-test
# refuses to run a turn on it.
MIN_GIT_VERSION: tuple[int, ...] = (2, 53)
# Characters of git's own output that may travel in an error detail.
DETAIL_CHARS = 600
# What of the output of a command on the agent's data may travel: only the guard's own denials.
AGENT_DETAIL_CHARS = 300
GUARD_DENIAL = "code-reviewer-guard: "
DEFAULT_TIMEOUT = 600.0

_VERSION = re.compile(r"git version (\d+(?:\.\d+)*)")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")


def parse_git_version(text: str) -> tuple[int, ...] | None:
    found = _VERSION.search(text)
    if found is None:
        return None
    return tuple(int(part) for part in found.group(1).split("."))


def basic_authorization(token: str) -> str:
    """The `Authorization` header value GitHub accepts for an installation token over HTTPS."""
    return "Basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode()


def token_environment(token: str) -> dict[str, str]:
    """The token for one git process, as `GIT_CONFIG_*` environment variables: never in argv, a
    config file or a URL. Redirects are not followed (a header must not follow a redirect), and no
    credential helper is consulted."""
    settings = (
        ("http.extraHeader", f"Authorization: {basic_authorization(token)}"),
        ("http.followRedirects", "false"),
        ("credential.helper", ""),
    )
    environment = {"GIT_CONFIG_COUNT": str(len(settings))}
    for number, (key, value) in enumerate(settings):
        environment[f"GIT_CONFIG_KEY_{number}"] = key
        environment[f"GIT_CONFIG_VALUE_{number}"] = value
    return environment


def spawn_options(uid: int, gid: int) -> dict[str, Any]:
    """The `Popen` keywords that make a child the agent's user: no other group, no root. A process
    that already is that user needs no change (and, unprivileged, could not drop its groups)."""
    if (uid, gid) == (os.geteuid(), os.getegid()):
        return {}
    return {"user": uid, "group": gid, "extra_groups": []}


def fail(code: ErrorCode, detail: str) -> JobError:
    return JobError(code, detail)


@dataclass(frozen=True)
class Outcome:
    returncode: int
    stdout: str
    stderr: str


class GitProcess:
    """One git executable and the closed environment every process of the workspace gets."""

    def __init__(self, git: str, path: str, home: Path, token: str) -> None:
        self.git = git
        self.path = path
        self._home = home
        self._token = token
        self._redactor = Redactor([token, f"x-access-token:{token}", basic_authorization(token)])

    def base_environment(self, protocols: str) -> dict[str, str]:
        return {
            "PATH": self.path,
            "HOME": str(self._home),
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ALLOW_PROTOCOL": protocols,
        }

    def detail(self, text: str) -> str:
        """The output of git on the runner's own data (the mirror, the provider) made safe to log:
        the token and the header are gone, control characters are gone, and it is short."""
        cleaned = _CONTROL.sub("?", self._redactor.redact(text)).strip()
        lines = [line for line in cleaned.splitlines() if line.strip()]
        return " | ".join(lines)[-DETAIL_CHARS:]

    def agent_detail(self, text: str) -> str:
        """The output of a git command that worked on what the agent controls (its repository, its
        refs, its config): none of it travels, because the agent decides what git prints
        (`fatal: unexpected line in ./packed-refs: <that line>`). Only a denial of the guard hook
        does, a fixed text, cleaned and short. An empty string says that nothing could be kept."""
        kept = [
            _CONTROL.sub("?", line).strip()
            for line in self._redactor.redact(text).splitlines()
            if line.startswith(GUARD_DENIAL)
        ]
        return " | ".join(kept)[:AGENT_DETAIL_CHARS]

    def run(
        self,
        args: Sequence[str],
        *,
        env: Mapping[str, str],
        cwd: Path | str = "/",
        spawn: Mapping[str, Any] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> Outcome:
        """Run git. The result is never raised on: the caller knows what a failure means. A process
        that cannot start or runs past the timeout is a failure with return code 255."""
        try:
            child = subprocess.Popen(
                [self.git, *args],
                cwd=cwd,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                # A group of its own, so that a timeout takes git's children (upload-pack, the
                # transport helper) down with it instead of leaving them behind.
                start_new_session=True,
                **(spawn or {}),
            )
        except OSError as error:
            return Outcome(255, "", f"git cannot run: {error.strerror or 'error'}")
        try:
            stdout, stderr = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(child.pid, signal.SIGKILL)
            with contextlib.suppress(subprocess.TimeoutExpired):
                child.communicate(timeout=10)
            return Outcome(255, "", f"git {args[0] if args else ''} timed out")
        return Outcome(child.returncode, stdout, stderr)
