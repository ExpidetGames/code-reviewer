# SPDX-License-Identifier: LicenseRef-Proprietary

"""IPv6 is off, and provably so, where the fallback ruleset is in use (#345), without root.

The `ip`-family table does not see IPv6, so in fallback mode the engine user's IPv6 must not work
at all. The proof reads the kernel's own files (sysctls, addresses, routes), tries to bind `::1`
and runs an IPv6 connect and send as the engine user. Here the files are a fake `/proc` and the
engine-user run is injected; the real kernel's answers are the privileged suite's (T16).
"""

import errno
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from code_reviewer_runner.dynamic_review import ipv6_off
from code_reviewer_runner.dynamic_review.ipv6_off import (
    disable_ipv6,
    ipv6_problem,
    verify_ipv6_off,
)
from code_reviewer_runner.dynamic_review.netguard import IsolationError

# What a kernel prints for the routes it keeps with IPv6 switched off: the "unreachable" null
# entry (flags RTF_UP|RTF_REJECT|RTF_NONEXTHOP) and nothing that can carry a packet.
NULL_ROUTE = (
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 "
    "00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo\n"
)
DEFAULT_ROUTE = (
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 "
    "fe800000000000000000000000000001 00000400 00000001 00000000 00000003     eth0\n"
)
NO_IPV6_ERRNOS = {errno.ENETUNREACH, errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT}


def fake_proc(
    tmp_path: Path,
    *,
    interfaces: tuple[str, ...] = ("all", "default", "lo", "eth0"),
    values: dict[str, str] | None = None,
    addresses: str = "",
    routes: str = NULL_ROUTE,
) -> Path:
    """A /proc of a host with IPv6 switched off (the defaults) unless told otherwise."""
    root = tmp_path / "proc"
    for name in interfaces:
        entry = root / "sys" / "net" / "ipv6" / "conf" / name
        entry.mkdir(parents=True)
        (entry / "disable_ipv6").write_text((values or {}).get(name, "1") + "\n")
    (root / "net").mkdir(parents=True, exist_ok=True)
    (root / "net" / "if_inet6").write_text(addresses)
    (root / "net" / "ipv6_route").write_text(routes)
    return root


def refused_by_the_kernel(results: dict[str, int | None] | None = None) -> str:
    """The engine user's answer: each attempt and the errno it ended in."""
    attempts = ("tcp_loopback", "udp_loopback", "tcp_global", "udp_global")
    base: dict[str, int | None] = dict.fromkeys(attempts, errno.ENETUNREACH)
    return json.dumps({**base, **(results or {})})


def no_loopback() -> bool:
    return False


# #345-T07
def test_a_host_with_ipv6_switched_off_has_no_problem(tmp_path: Path) -> None:
    assert ipv6_problem(fake_proc(tmp_path), bindable=no_loopback) is None


# #345-T07
def test_a_kernel_without_ipv6_at_all_has_no_problem(tmp_path: Path) -> None:
    empty = tmp_path / "proc"
    (empty / "net").mkdir(parents=True)

    assert ipv6_problem(empty, bindable=no_loopback) is None


# #345-T07
@pytest.mark.parametrize("interface", ["all", "default", "lo", "eth0"])
def test_any_interface_setting_that_is_not_one_is_a_problem(tmp_path: Path, interface: str) -> None:
    root = fake_proc(tmp_path, values={interface: "0"})

    problem = ipv6_problem(root, bindable=no_loopback)

    assert problem is not None and "switched off" in problem


# #345-T07
@pytest.mark.parametrize("content", ["", "garbage", "2\n"])
def test_a_setting_that_cannot_be_read_as_one_counts_as_not_off(
    tmp_path: Path, content: str
) -> None:
    root = fake_proc(tmp_path)
    (root / "sys/net/ipv6/conf/all/disable_ipv6").write_text(content)

    assert ipv6_problem(root, bindable=no_loopback) is not None


# #345-T07
def test_a_conf_directory_without_all_or_default_is_a_problem(tmp_path: Path) -> None:
    root = fake_proc(tmp_path, interfaces=("lo",))

    assert ipv6_problem(root, bindable=no_loopback) is not None


# #345-T07
def test_an_ipv6_address_is_a_problem(tmp_path: Path) -> None:
    loopback = "00000000000000000000000000000001 01 80 10 80       lo\n"
    root = fake_proc(tmp_path, addresses=loopback)

    problem = ipv6_problem(root, bindable=no_loopback)

    assert problem is not None and "address" in problem


# #345-T07
def test_a_route_that_can_carry_a_packet_is_a_problem_and_a_reject_route_is_not(
    tmp_path: Path,
) -> None:
    assert ipv6_problem(fake_proc(tmp_path, routes=NULL_ROUTE * 3), bindable=no_loopback) is None

    problem = ipv6_problem(
        fake_proc(tmp_path / "other", routes=NULL_ROUTE + DEFAULT_ROUTE), bindable=no_loopback
    )

    assert problem is not None and "route" in problem


# #345-T07
def test_a_route_line_nobody_can_parse_is_a_problem(tmp_path: Path) -> None:
    assert ipv6_problem(fake_proc(tmp_path, routes="what is this\n"), bindable=no_loopback)


# #345-T07
def test_an_ipv6_loopback_that_can_be_bound_is_a_problem(tmp_path: Path) -> None:
    problem = ipv6_problem(fake_proc(tmp_path), bindable=lambda: True)

    assert problem is not None and "loopback" in problem


# #345-T07
def test_the_real_loopback_check_is_false_when_ipv6_is_not_there_or_not_usable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class NoIpv6:
        def __init__(self, *args: object) -> None:
            raise OSError(errno.EAFNOSUPPORT, "no ipv6")

    monkeypatch.setattr(
        ipv6_off,
        "socket",
        SimpleNamespace(socket=NoIpv6, AF_INET6=10, SOCK_STREAM=1),
    )

    assert ipv6_off.can_bind_ipv6_loopback() is False


# #345-T05
def test_disabling_writes_a_one_to_default_all_and_every_interface(tmp_path: Path) -> None:
    root = fake_proc(tmp_path, values={"all": "0", "default": "0", "lo": "0", "eth0": "0"})

    disable_ipv6(root)

    for name in ("all", "default", "lo", "eth0"):
        assert (root / "sys/net/ipv6/conf" / name / "disable_ipv6").read_text().strip() == "1"


# #345-T06
def test_disabling_never_raises_when_the_kernel_will_not_let_it(tmp_path: Path) -> None:
    # A container's /proc/sys is read-only: the setting has to come from the container spec, and
    # the proof below is what decides. A missing directory is the same.
    disable_ipv6(tmp_path / "nothing")
    root = fake_proc(tmp_path, values={"all": "0"})
    (root / "sys/net/ipv6/conf/all/disable_ipv6").chmod(0o444)

    disable_ipv6(root)  # a read-only file in a tree we may write to: no exception either


# #345-T08
@pytest.mark.parametrize("code", sorted(NO_IPV6_ERRNOS))
def test_every_no_ipv6_errno_is_enough_to_pass(tmp_path: Path, code: int) -> None:
    answers = refused_by_the_kernel(dict.fromkeys(("tcp_loopback", "udp_loopback"), code))

    verify_ipv6_off(
        10101,
        10101,
        root=fake_proc(tmp_path),
        run_probe=lambda argv, uid, gid: answers,
        bindable=no_loopback,
    )


# #345-T08
@pytest.mark.parametrize(
    "bad",
    [None, 0, errno.ECONNREFUSED, errno.EACCES, errno.EHOSTUNREACH, errno.ETIMEDOUT],
)
@pytest.mark.parametrize("attempt", ["tcp_loopback", "udp_loopback", "tcp_global", "udp_global"])
def test_any_other_answer_of_the_engine_user_is_not_a_proof(
    tmp_path: Path, attempt: str, bad: int | None
) -> None:
    # None is a timeout, 0 a connection that was made; ECONNREFUSED is what a working IPv6
    # loopback says to a port nobody listens on, which is why it proves nothing.
    answers = refused_by_the_kernel({attempt: bad})

    with pytest.raises(IsolationError) as caught:
        verify_ipv6_off(
            10101,
            10101,
            root=fake_proc(tmp_path),
            run_probe=lambda argv, uid, gid: answers,
            bindable=no_loopback,
        )

    assert "IPv6" in caught.value.detail


# #345-T08
@pytest.mark.parametrize("output", ["", "not json", "[]", "{}", '{"tcp_loopback": 101}'])
def test_an_answer_that_is_not_the_whole_result_is_not_a_proof(tmp_path: Path, output: str) -> None:
    with pytest.raises(IsolationError):
        verify_ipv6_off(
            10101,
            10101,
            root=fake_proc(tmp_path),
            run_probe=lambda argv, uid, gid: output,
            bindable=no_loopback,
        )


# #345-T08
def test_the_files_are_judged_before_the_engine_user_is_asked_anything(tmp_path: Path) -> None:
    asked: list[list[str]] = []

    def probe(argv: list[str], uid: int, gid: int) -> str:
        asked.append(argv)
        return refused_by_the_kernel()

    with pytest.raises(IsolationError):
        verify_ipv6_off(
            10101,
            10101,
            root=fake_proc(tmp_path, values={"lo": "0"}),
            run_probe=probe,
            bindable=no_loopback,
        )
    assert asked == []

    verify_ipv6_off(
        10101, 10101, root=fake_proc(tmp_path / "ok"), run_probe=probe, bindable=no_loopback
    )
    assert len(asked) == 1
    # Fixed text, run as the engine user in isolated mode: no repository input in it.
    assert asked[0][1:3] == ["-I", "-c"]
