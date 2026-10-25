# SPDX-License-Identifier: LicenseRef-Proprietary

"""No AF_UNIX path to anything but the engine's own sockets (#244, from the review of #239).

The nft rules cover TCP, UDP and IPv6 of the engine user, but not AF_UNIX: a unix socket reaches any
listener in the container's network namespace, or any socket file on a filesystem the engine user
can see. Today nothing in the container listens on one and nothing is mounted (the compose file has
no `volumes`, `network_mode`, `pid`, `ipc` or Docker socket: `app/src/ci/compose-dynamic.test.ts`),
so the gap is empty. These tests, run as the engine user while a real engine stand-in is running,
keep it empty: they fail the day a listener (a unix-socket proxy, a credential helper) or a socket
file appears, and they prove they would notice one.

The suite runs in a mount namespace with a fresh `/run` (`scripts/run_privileged_offline.sh`), like
a container that mounts nothing from the host; on a CI host with a Docker socket the check would
otherwise be about the host and not about the container.
"""

import json
import os
import socket
from pathlib import Path

from privileged_support import ENGINE_GID, ENGINE_UID, Repo, run_as
from test_engine_launch import started_engine

DOCKER_SOCKETS = ("/var/run/docker.sock", "/run/docker.sock")

# Runs as the engine user. A unix socket is "its own" when one of the processes that user may look
# into (its own) holds it. A listener is a socket with SO_ACCEPTCON (flag 0x10000).
FOREIGN_LISTENERS = r"""
import json, os, stat
own = set()
for pid in os.listdir("/proc"):
    if not pid.isdigit():
        continue
    try:
        descriptors = os.listdir(f"/proc/{pid}/fd")
    except OSError:
        continue  # another user's process: not ours to look into
    for descriptor in descriptors:
        try:
            target = os.readlink(f"/proc/{pid}/fd/{descriptor}")
        except OSError:
            continue
        if target.startswith("socket:["):
            own.add(int(target[8:-1]))
listeners = []
with open("/proc/net/unix") as table:
    next(table)
    for line in table:
        fields = line.split()
        if int(fields[3], 16) & 0x10000 and int(fields[6]) not in own:
            listeners.append(fields[7] if len(fields) > 7 else "(unnamed)")
files = []
for root in ("/run", "/var/run"):
    for directory, _, names in os.walk(root, followlinks=False):
        for name in names:
            try:
                if stat.S_ISSOCK(os.lstat(os.path.join(directory, name)).st_mode):
                    files.append(os.path.join(directory, name))
            except OSError:
                pass
print(json.dumps({"listeners": listeners, "socket_files": files}))
"""

LOOKS_FOR_DOCKER = (
    "import json, os, sys; print(json.dumps([p for p in sys.argv[1:] if os.path.lexists(p)]))"
)


def look_as_the_engine_user() -> dict[str, list[str]]:
    done = run_as(ENGINE_UID, ENGINE_GID, FOREIGN_LISTENERS)
    assert done.returncode == 0, done.stderr
    found: dict[str, list[str]] = json.loads(done.stdout)
    present = run_as(ENGINE_UID, ENGINE_GID, LOOKS_FOR_DOCKER, *DOCKER_SOCKETS)
    assert present.returncode == 0, present.stderr
    found["docker"] = json.loads(present.stdout)
    return found


# #244-T11
def test_the_engine_user_sees_no_unix_listener_but_its_own_and_no_docker_socket(
    repo: Repo, environment: dict[str, str], tools: Path, job_dir: Path
) -> None:
    with started_engine(repo, environment, tools):
        found = look_as_the_engine_user()

    assert found["listeners"] == []
    assert found["socket_files"] == []
    assert found["docker"] == []
    assert not any(os.path.lexists(path) for path in DOCKER_SOCKETS)


# #244-T11
def test_the_check_notices_a_foreign_listener_and_a_socket_file_when_they_appear() -> None:
    # Without this the test above could pass for the wrong reason (an unreadable table, a wrong
    # column). A root-owned listener, abstract and on a path, is somebody else's to the engine
    # user, and a socket file in /run is found whoever listens.
    run_directory = Path("/run")
    path = run_directory / "cr-privileged-listener.sock"
    path.unlink(missing_ok=True)
    named = socket.socket(socket.AF_UNIX)
    abstract = socket.socket(socket.AF_UNIX)
    try:
        named.bind(str(path))
        named.listen(1)
        abstract.bind("\0cr-privileged-abstract")
        abstract.listen(1)
        os.chmod(path, 0o666)
        found = look_as_the_engine_user()
    finally:
        named.close()
        abstract.close()
        path.unlink(missing_ok=True)

    assert str(path) in found["listeners"]
    assert "@cr-privileged-abstract" in found["listeners"]
    assert str(path) in found["socket_files"]


# #244-T11
def test_a_unix_listener_of_the_engine_user_itself_is_not_foreign() -> None:
    holder = (
        "import socket, subprocess, sys; "
        "s = socket.socket(socket.AF_UNIX); s.bind('\\0cr-privileged-own'); s.listen(1); "
        "print(subprocess.run([sys.executable, '-I', '-c', sys.argv[1]], capture_output=True, "
        "text=True).stdout)"
    )
    done = run_as(ENGINE_UID, ENGINE_GID, holder, FOREIGN_LISTENERS)
    assert done.returncode == 0, done.stderr
    found = json.loads(done.stdout)

    assert "@cr-privileged-own" not in found["listeners"]
