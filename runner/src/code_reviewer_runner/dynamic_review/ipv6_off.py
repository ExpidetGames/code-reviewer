# SPDX-License-Identifier: LicenseRef-Proprietary
"""IPv6 off, and proven off, for the fallback egress ruleset (#345).

The fallback ruleset is an `ip`-family table: it confines the engine user's IPv4 and sees no IPv6
packet at all. Where it is in use IPv6 must therefore not work for the engine user, and "not
configured" is not enough, so the same two steps as everywhere else in this container apply:

* startup, which still holds `NET_ADMIN`, switches IPv6 off with the kernel's sysctls
  (`disable_ipv6` of `default`, `all` and every interface), as far as the container lets it. A
  container's `/proc/sys` is usually read-only; then the setting has to come from the container
  spec (`--sysctl net.ipv6.conf.all.disable_ipv6=1`, the same for `default`) and nothing here
  fails: the proof decides;
* the proof (`verify_ipv6_off`) needs no capability. It reads the kernel's own files: every
  `disable_ipv6` reads 1, there is no IPv6 address and no route that could carry a packet, and
  `::1` cannot be bound; then, as the engine user, an IPv6 connect and an IPv6 send to the loopback
  and to a documentation address must end in an error that only a host without IPv6 gives
  (`ENETUNREACH`, `EADDRNOTAVAIL`, `EAFNOSUPPORT`). A refusal, a timeout or a success is no proof:
  a working IPv6 loopback refuses a closed port, and a dropped packet times out.

It runs in the self-check and again before every engine of a job in fallback mode. Anything that
cannot be read or understood counts as "not off".
"""

import errno
import json
import shutil
import socket
from collections.abc import Callable
from pathlib import Path
from typing import Any

from code_reviewer_runner.job_loop.jsonvalues import as_object

from .netguard import IsolationError, ProbeRunner, run_probe_as_user

_TRUSTED_PATH = "/usr/local/bin:/usr/bin:/bin"
PROC_ROOT = Path("/proc")
# The errors a host gives when IPv6 is not there. Not `ECONNREFUSED`: a working IPv6 loopback says
# that to a closed port. Not a timeout: that is a dropped packet on a stack that works.
NO_IPV6_ERRNOS = frozenset({errno.ENETUNREACH, errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT})
_RTF_REJECT = 0x0200
_ATTEMPTS = ("tcp_loopback", "udp_loopback", "tcp_global", "udp_global")

# Runs as the engine user: one IPv6 connect and one IPv6 send to the loopback, and to an address of
# the documentation range (RFC 3849, never routed). Prints the errno of each, 0 when it worked and
# null when it timed out. Fixed text, no repository input.
_PROBE = r"""
import json, socket
def attempt(kind, address):
    try:
        endpoint = socket.socket(socket.AF_INET6, kind)
    except OSError as error:
        return error.errno
    try:
        endpoint.settimeout(1.0)
        if kind == socket.SOCK_STREAM:
            endpoint.connect((address, 9))
        else:
            endpoint.sendto(b"x", (address, 9))
    except OSError as error:
        return error.errno
    finally:
        endpoint.close()
    return 0
stream, datagram = socket.SOCK_STREAM, socket.SOCK_DGRAM
print(json.dumps({
    "tcp_loopback": attempt(stream, "::1"),
    "udp_loopback": attempt(datagram, "::1"),
    "tcp_global": attempt(stream, "2001:db8::1"),
    "udp_global": attempt(datagram, "2001:db8::1"),
}))
"""


def can_bind_ipv6_loopback() -> bool:
    """True when this process can open an IPv6 socket bound to `::1`: IPv6 loopback works."""
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as endpoint:
            endpoint.bind(("::1", 0))
    except OSError:
        return False
    return True


def _conf_directory(root: Path) -> Path:
    return root / "sys" / "net" / "ipv6" / "conf"


def disable_ipv6(root: Path = PROC_ROOT) -> None:
    """Switch IPv6 off as far as this container may: `default`, `all`, then every interface.

    `default` first so an interface that appears later starts disabled. Never raises: a read-only
    `/proc/sys` is the normal case in a container, and `ipv6_problem` is what judges the result.
    """
    conf = _conf_directory(root)
    try:
        names = sorted(entry.name for entry in conf.iterdir())
    except OSError:
        return
    ordered = ["default", "all", *(name for name in names if name not in ("default", "all"))]
    for name in ordered:
        try:
            (conf / name / "disable_ipv6").write_text("1\n", encoding="ascii")
        except OSError:
            continue


def _setting_problem(root: Path) -> str | None:
    conf = _conf_directory(root)
    if not conf.exists():
        return None  # a kernel without IPv6 has no settings and nothing to switch off
    try:
        names = {entry.name for entry in conf.iterdir()}
    except OSError:
        return "the IPv6 settings cannot be read"
    if not {"all", "default"} <= names:
        return "the IPv6 settings cannot be read"
    for name in sorted(names):
        try:
            value = (conf / name / "disable_ipv6").read_text(encoding="ascii").strip()
        except OSError:
            return "the IPv6 settings cannot be read"
        if value != "1":
            return "IPv6 is not switched off on every interface"
    return None


def _address_problem(root: Path) -> str | None:
    try:
        text = (root / "net" / "if_inet6").read_text(encoding="ascii", errors="replace")
    except FileNotFoundError:
        return None
    except OSError:
        return "the IPv6 addresses cannot be read"
    if text.strip():
        return "an IPv6 address exists"
    return None


def _route_problem(root: Path) -> str | None:
    try:
        text = (root / "net" / "ipv6_route").read_text(encoding="ascii", errors="replace")
    except FileNotFoundError:
        return None
    except OSError:
        return "the IPv6 routes cannot be read"
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split()
        try:
            flags = int(fields[8], 16)
        except (IndexError, ValueError):
            return "an IPv6 route cannot be understood"
        # The kernel keeps "unreachable" entries even with IPv6 off; they carry nothing.
        if not flags & _RTF_REJECT:
            return "an IPv6 route exists"
    return None


def ipv6_problem(
    root: Path = PROC_ROOT, *, bindable: Callable[[], bool] = can_bind_ipv6_loopback
) -> str | None:
    """Why IPv6 is not off according to the kernel's files and `::1`, or None. Names no value."""
    for check in (_setting_problem, _address_problem, _route_problem):
        problem = check(root)
        if problem is not None:
            return problem
    if bindable():
        return "the IPv6 loopback is usable"
    return None


def _engine_user_problem(output: str) -> str | None:
    try:
        document: Any = json.loads(output)
    except ValueError:
        document = None
    answers = as_object(document)
    if answers is None:
        return "the IPv6 probe returned no result"
    for attempt in _ATTEMPTS:
        code = answers.get(attempt)
        if isinstance(code, bool) or not isinstance(code, int) or code not in NO_IPV6_ERRNOS:
            return "the engine user can use IPv6"
    return None


def verify_ipv6_off(
    uid: int,
    gid: int,
    *,
    root: Path = PROC_ROOT,
    run_probe: ProbeRunner = run_probe_as_user,
    bindable: Callable[[], bool] = can_bind_ipv6_loopback,
) -> None:
    """Prove that IPv6 is off for the engine user. Raises `IsolationError` otherwise.

    The kernel's files are judged first; the engine user is asked only when they look right.
    """
    problem = ipv6_problem(root, bindable=bindable)
    if problem is not None:
        raise IsolationError(problem)
    python = shutil.which("python3", path=_TRUSTED_PATH)
    if python is None:
        raise IsolationError("no interpreter for the IPv6 probe")
    problem = _engine_user_problem(run_probe([python, "-I", "-c", _PROBE], uid, gid))
    if problem is not None:
        raise IsolationError(problem)
