# SPDX-License-Identifier: Apache-2.0
"""Launching the engine as the dedicated unprivileged user, and ending all that user runs (#197).

The job process is the root supervisor: it prepared the read-only export (#196, `export_isolation`),
runs the model proxy and holds every credential. The engine is a different user in the same
container. This module is the supervisor's side of that boundary:

* the `Popen` options that start a process as that user, with no supplementary groups (a
  `setuid()` in the child, no `sudo`, no setuid helper: `no-new-privileges` stays on);
* the engine's config file, readable by that user and nobody else;
* the proof that the engine's server port is held by the engine and not by a stranger;
* the network rules of that user (`netguard.py`), installed per job and proven before the start;
* the end of the job: everything that user still runs is killed, also what left the process group.

A process group alone is not enough: a helper may `setsid()` and leave it. The dedicated user is
the boundary, so the final step is a `kill(-1, SIGKILL)` run **as that user** (the kernel then
signals exactly the processes that user owns; nobody else can be reached and no pid is looked up and
reused). No capability beyond `SETUID`/`SETGID` is involved for that, and `KILL` lets the supervisor
signal the engine's group.
"""

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .netguard import IsolationError, NetworkConfinement, verify_confinement

_TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
_SWEEP_SECONDS = 10.0
_LISTEN = "0A"
_PROC_TABLES = ("/proc/net/tcp", "/proc/net/tcp6")

_SWEEP = "import os, signal; os.kill(-1, signal.SIGKILL)"
# A process that was forking while it was signalled can leave a child behind; look again.
_SWEEP_ROUNDS = 5


def user_pids(uid: int) -> list[int]:
    """The live (not zombie) processes whose real user is `uid`, read from /proc."""
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text(encoding="ascii", errors="replace")
        except OSError:
            continue  # it ended while we looked
        state = ""
        real = -1
        for line in status.splitlines():
            if line.startswith("State:"):
                state = line.split()[1] if len(line.split()) > 1 else ""
            elif line.startswith("Uid:"):
                try:
                    real = int(line.split()[1])
                except (IndexError, ValueError):
                    real = -1
        if real == uid and state != "Z":
            found.append(int(entry.name))
    return found


def listener_uids(port: int, tables: dict[str, str]) -> set[int]:
    """The owners of every listening socket on `port`, read from /proc/net/tcp{,6} texts."""
    owners: set[int] = set()
    wanted = f"{port:04X}"
    for text in tables.values():
        for line in text.splitlines()[1:]:
            fields = line.split()
            if len(fields) < 8 or fields[3] != _LISTEN:
                continue
            if fields[1].rsplit(":", 1)[-1].upper() != wanted:
                continue
            try:
                owners.add(int(fields[7]))
            except ValueError:
                owners.add(-1)  # unreadable owner: never equal to the engine user
    return owners


def _read_tables() -> dict[str, str]:
    tables: dict[str, str] = {}
    for name in _PROC_TABLES:
        try:
            tables[name] = Path(name).read_text(encoding="ascii", errors="replace")
        except OSError:
            continue
    return tables


@dataclass
class EngineLaunch:
    """What the adapter needs to run one engine as the dedicated user. One per job."""

    uid: int
    gid: int
    # Where the engine's HOME, XDG and temporary directories are (owned by the engine user).
    home: str
    tmpdir: str
    # A root-owned directory the engine user can enter but not list; the config file goes in it.
    config_dir: Path
    confinement: NetworkConfinement = field(init=False)
    _verified: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self.confinement = NetworkConfinement(self.uid)

    # -- starting -------------------------------------------------------------

    def spawn_options(self) -> dict[str, Any]:
        """The `Popen` keywords that make the child the engine user: no other group, no root."""
        return {"user": self.uid, "group": self.gid, "extra_groups": []}

    def write_config(self, config: dict[str, Any]) -> Path:
        """Write the engine config so that only the engine user (and root) can read it.

        It carries the job's proxy capability. The directory is root's and not listable by the
        engine; the file is owned by the engine user with mode 0400, so no other user of the
        container can read it either (#202: config readability).
        """
        path = self.config_dir / "opencode.json"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(config))
            os.fchown(stream.fileno(), self.uid, self.gid)
            os.fchmod(stream.fileno(), 0o400)
        return path

    def confine(self, proxy_port: int, engine_port: int) -> None:
        """Install the network rules for this job and, once, prove they are in effect.

        The first call also ends whatever the user still runs: a job process that was killed
        without a chance to clean up (SIGKILL, an OOM kill) leaves its engine behind, and the
        lease on the user is free again the moment that process is gone.
        """
        if not self._verified:
            self.sweep()
        self.confinement.apply([proxy_port, engine_port])
        if not self._verified:
            verify_confinement(self.uid, self.gid, proxy_port)
            self._verified = True

    def owns_listener(self, port: int, *, tables: dict[str, str] | None = None) -> bool:
        """True when the engine user, and nobody else, listens on `port`."""
        owners = listener_uids(port, _read_tables() if tables is None else tables)
        return owners == {self.uid}

    # -- ending ---------------------------------------------------------------

    def sweep(self) -> bool:
        """Kill every process of the engine user, wherever it went. True when none is left."""
        python = shutil.which("python3", path=_TRUSTED_PATH)
        if python is None:
            return False
        for _ in range(_SWEEP_ROUNDS):
            if not user_pids(self.uid):
                return True
            try:
                subprocess.run(
                    [python, "-I", "-c", _SWEEP],
                    user=self.uid,
                    group=self.gid,
                    extra_groups=(),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=_SWEEP_SECONDS,
                    check=False,
                    env={"PATH": _TRUSTED_PATH},
                )
            except (OSError, subprocess.TimeoutExpired):
                return False
            time.sleep(0.02)
        return not user_pids(self.uid)

    def close(self) -> None:
        """End the job's use of the user: nothing of it runs, its network rules are gone."""
        self.sweep()
        self.confinement.remove()


__all__ = ["EngineLaunch", "IsolationError", "listener_uids", "user_pids"]
