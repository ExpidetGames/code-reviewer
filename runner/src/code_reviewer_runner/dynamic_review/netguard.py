# SPDX-License-Identifier: Apache-2.0
"""The engine user's network boundary: it may reach its job's model proxy and nothing else (#197).

The engine runs as a dedicated unprivileged user in the runner container. Tool denial is not a
network boundary, so the operating system enforces one: an nftables output filter keyed on the
socket owner (`meta skuid`) that lets that one user open new connections only to the loopback
address of this job's model proxy (and to the engine's own server port). Everything else it tries
(another job's loopback service, any other address, IPv6, UDP, raw sends) is rejected at once.
Only the answers of the engine's own server pass as replies (never "any tracked flow"). The
supervisor that owns the root privileges (the job process, `NET_ADMIN`) installs the rules; the
engine user cannot change them.

A per-job network namespace would need `SYS_ADMIN`, a user namespace is excluded by the lead
decisions and a container-level rule cannot tell the supervisor (GitHub, the model upstream) from
the engine in the same container. The rules are therefore proven in effect before the engine
starts: a probe running as the engine user must reach the proxy and must be refused everywhere
else; any other result is `dynamic_isolation_self_check_failed` and no engine is started.
"""

import contextlib
import json
import shutil
import socket
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.result import ErrorCode

PROXY_HOST = "127.0.0.1"
# A second loopback address: not the proxy's, so it stands in for "any other host" in the probe.
_OTHER_HOST = "127.0.0.2"
_TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
# `nft` lives in /usr/sbin on Debian and Ubuntu.
_NFT_PATH = f"/usr/sbin:/sbin:{_TRUSTED_PATH}"
_NFT_TIMEOUT_SECONDS = 10.0
_PROBE_TIMEOUT_SECONDS = 15.0
_CONNECT_TIMEOUT_SECONDS = 2.0
_UDP_WAIT_SECONDS = 0.5

# Runs as the engine user: one connection to the allowed port, one to each forbidden stand-in, and
# one datagram. Prints which connections got through. Fixed text, no repository input.
_PROBE = r"""
import json, socket, sys
host, allowed, tcp_ports, other_host, other_port, udp_port = sys.argv[1:7]
def connect(address, port):
    try:
        with socket.create_connection((address, int(port)), timeout=float(sys.argv[7])):
            return True
    except OSError:
        return False
reached = {
    "allowed": connect(host, allowed),
    "other_port": connect(host, tcp_ports),
    "other_host": connect(other_host, other_port),
}
try:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as datagram:
        datagram.sendto(b"x", (host, int(udp_port)))
except OSError:
    pass  # a refused send is the expected outcome; the supervisor looks at what arrived
print(json.dumps(reached))
"""


class IsolationError(Exception):
    """The network boundary is not in effect. `detail` names the property, never a value."""

    def __init__(self, detail: str) -> None:
        super().__init__(f"{ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED.value}: {detail}")
        self.code = ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
        self.detail = detail


# Runs `nft` with a script on stdin. A test replaces it; the real one is `_run_nft`.
NftRunner = Callable[[str], None]


def table_name(uid: int) -> str:
    return f"code_reviewer_engine_{uid}"


def ruleset(uid: int, proxy_port: int, engine_port: int) -> str:
    """The nft script that confines `uid` to loopback TCP to `proxy_port` and `engine_port`.

    `add table` + `flush table` makes it idempotent: installing again replaces the rules of this
    uid (the engine's own port changes when a start is retried on another one).

    Nothing is accepted by connection state alone: a flow another process opened (the
    supervisor's DNS lookup, say) stays tracked for a while after its socket closed, and the user
    could send on it from the same source port. Replies are accepted only as the answers of the
    engine's own server port.
    """
    ports = (proxy_port, engine_port)
    if uid <= 0 or any(not 0 < port < 65536 for port in ports) or proxy_port == engine_port:
        raise IsolationError("the network rules are given an unusable user or port")
    table = table_name(uid)
    loopback = f'oifname "lo" ip daddr {PROXY_HOST}'
    return "\n".join(
        [
            f"add table inet {table}",
            f"flush table inet {table}",
            f"add chain inet {table} output {{ type filter hook output priority 0 ; "
            "policy accept ; }",
            f"add rule inet {table} output meta skuid {uid} ct state established,related accept",
            # The answers of the engine's own server to whoever connected to it (the supervisor).
            f'add rule inet {table} output meta skuid {uid} oifname "lo" ip saddr {PROXY_HOST} '
            f"ip daddr {PROXY_HOST} tcp sport {engine_port} ct state established accept",
            # The only new connections: this job's proxy and the engine's own server.
            f"add rule inet {table} output meta skuid {uid} {loopback} tcp dport {proxy_port} "
            "accept",
            f"add rule inet {table} output meta skuid {uid} {loopback} tcp dport {engine_port} "
            "accept",
            # Every other packet of that user: refused at once, not silently dropped.
            f"add rule inet {table} output meta skuid {uid} "
            "reject with icmpx type admin-prohibited",
            "",
        ]
    )


def _run_nft(script: str) -> None:
    executable = shutil.which("nft", path=_NFT_PATH)
    if executable is None:
        raise IsolationError("the network filter tool is not installed")
    try:
        outcome = subprocess.run(
            [executable, "-f", "-"],
            input=script,
            capture_output=True,
            text=True,
            timeout=_NFT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise IsolationError("the network filter could not be run") from None
    if outcome.returncode != 0:
        raise IsolationError("the network filter was refused by the kernel")


@dataclass
class NetworkConfinement:
    """The nft rules of one engine user. `apply` installs them, `remove` takes them out again."""

    uid: int
    run: NftRunner = _run_nft
    _installed: bool = False

    def apply(self, proxy_port: int, engine_port: int) -> None:
        self.run(ruleset(self.uid, proxy_port, engine_port))
        self._installed = True

    def remove(self) -> None:
        if not self._installed:
            return
        self._installed = False
        # If the delete fails the user cannot start another engine anyway; the table dies with the
        # container.
        with contextlib.suppress(IsolationError):
            self.run(f"delete table inet {table_name(self.uid)}\n")


# Runs the probe as the engine user: argv, the user and group, returns the stdout text.
ProbeRunner = Callable[[list[str], int, int], str]


def _run_probe(argv: list[str], uid: int, gid: int) -> str:
    try:
        outcome = subprocess.run(
            argv,
            user=uid,
            group=gid,
            extra_groups=(),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
            check=False,
            env={"PATH": _TRUSTED_PATH},
        )
    except (OSError, subprocess.TimeoutExpired):
        raise IsolationError("the network probe could not be run as the engine user") from None
    if outcome.returncode != 0:
        raise IsolationError("the network probe failed as the engine user")
    return outcome.stdout


def verify_confinement(
    uid: int, gid: int, allowed_port: int, *, run_probe: ProbeRunner = _run_probe
) -> None:
    """Prove, as the engine user, that only `allowed_port` is reachable. Raises `IsolationError`.

    The sentinels are listeners this process owns: another "job's" port on the proxy address, a
    port on another loopback address and a UDP socket. Without the rules every one of them would
    accept, so a refusal is the rules at work, not a missing route. The allowed port must accept.
    """
    python = shutil.which("python3", path=_TRUSTED_PATH)
    if python is None:
        raise IsolationError("no interpreter for the network probe")
    with (
        socket.socket() as other_port,
        socket.socket() as other_host,
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as datagram,
    ):
        try:
            other_port.bind((PROXY_HOST, 0))
            other_port.listen(1)
            other_host.bind((_OTHER_HOST, 0))
            other_host.listen(1)
            datagram.bind((PROXY_HOST, 0))
            datagram.settimeout(_UDP_WAIT_SECONDS)
        except OSError:
            raise IsolationError("the network probe could not open its listeners") from None
        argv = [
            python,
            "-I",
            "-c",
            _PROBE,
            PROXY_HOST,
            str(allowed_port),
            str(other_port.getsockname()[1]),
            _OTHER_HOST,
            str(other_host.getsockname()[1]),
            str(datagram.getsockname()[1]),
            str(_CONNECT_TIMEOUT_SECONDS),
        ]
        output = run_probe(argv, uid, gid)
        try:
            datagram.recvfrom(16)
            datagram_arrived = True
        except OSError:
            datagram_arrived = False
    try:
        document: Any = json.loads(output)
    except ValueError:
        document = None
    reached = as_object(document)
    if reached is None:
        raise IsolationError("the network probe returned no result")
    if reached.get("allowed") is not True:
        raise IsolationError("the engine user cannot reach its model proxy")
    if reached.get("other_port") is not False or reached.get("other_host") is not False:
        raise IsolationError("the engine user can reach a service other than its model proxy")
    if datagram_arrived:
        raise IsolationError("the engine user can send datagrams")
