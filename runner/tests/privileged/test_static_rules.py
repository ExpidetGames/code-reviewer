# SPDX-License-Identifier: Apache-2.0

"""The static nft rules hold for a supervisor that cannot change them (#244, #197-T04/T09).

This is the job phase: the process running these tests is the Dynamic runner after its startup step.
The rules were installed by the production code when it started, `NET_ADMIN` and `SETPCAP` are gone
from every capability set and from the bounding set, and nothing here can add, remove or even list
a rule. What `startup/test_network_rules.py` proves of the rules as such is proven again here for
the rules a job really runs behind: the proxy and the engine's own port on the slot's fixed ports,
and nothing else. A refusal can only be the rules at work: every target is a loopback listener the
test owns, and the namespace has no route out.
"""

import errno
import shutil
import socket
import subprocess
from collections.abc import Generator
from contextlib import contextmanager

from privileged_support import (
    ENGINE_GID,
    ENGINE_PORT,
    ENGINE_UID,
    STRANGER_GID,
    STRANGER_UID,
    TRUSTED_PATH,
    connect_as,
    listener,
    run_as,
    slot_proxy,
)

from code_reviewer_runner.dynamic_review.netguard import table_name, verify_confinement

# What a refused connection looks like to the user: an immediate error from the reject, never a
# timeout (a silent drop).
REFUSED = {errno.EACCES, errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH}
SEND = (
    "import socket, sys; "
    "s = socket.socket(int(sys.argv[1]), socket.SOCK_DGRAM); "
    "s.bind((sys.argv[2], int(sys.argv[3]))); "
    "s.sendto(b'x', (sys.argv[4], int(sys.argv[5])))"
)


@contextmanager
def optional_ipv6_listener() -> Generator[int | None]:
    try:
        with listener("::1", socket.AF_INET6) as port:
            yield port
    except OSError:
        yield None


def arrives(sentinel: socket.socket) -> bool:
    try:
        sentinel.recvfrom(16)
    except OSError:
        return False
    return True


def send_datagram_as_engine(family: int, source: str, source_port: int, to: str, port: int) -> None:
    done = run_as(
        ENGINE_UID, ENGINE_GID, SEND, str(int(family)), source, str(source_port), to, str(port)
    )
    # A refused send may or may not be an error to the sender; only what arrives is judged.
    assert done.returncode in (0, 1), done.stderr


# #244-T09
def test_the_engine_user_reaches_the_slots_two_ports_and_nothing_else() -> None:
    with (
        slot_proxy() as proxy,
        listener(port=ENGINE_PORT) as engine_port,
        listener() as other_job,
        listener("127.0.0.2") as elsewhere,
        optional_ipv6_listener() as ipv6,
    ):
        targets = [
            ("proxy", "127.0.0.1", proxy),
            ("engine port", "127.0.0.1", engine_port),
            ("other job", "127.0.0.1", other_job),
            ("other address", "127.0.0.2", elsewhere),
        ]
        if ipv6 is not None:  # a kernel without IPv6 loopback has nothing to refuse
            targets.append(("ipv6 loopback", "::1", ipv6))
        engine = connect_as(ENGINE_UID, ENGINE_GID, targets)
        stranger = connect_as(STRANGER_UID, STRANGER_GID, targets)

    assert engine["proxy"]["connected"] is True
    assert engine["engine port"]["connected"] is True
    for label in (target[0] for target in targets[2:]):
        assert engine[label]["connected"] is False, label
        # Refused by the reject, not silently dropped (a drop ends in a timeout: no errno).
        assert engine[label]["errno"] in REFUSED, label
    # The rules name one user: another job's user reaches everything.
    assert all(result["connected"] for result in stranger.values())


# #244-T09
def test_datagrams_of_the_engine_user_to_any_address_are_refused() -> None:
    cases = [
        ("127.0.0.1", socket.AF_INET),
        ("127.0.0.2", socket.AF_INET),
        ("::1", socket.AF_INET6),
    ]
    arrived: dict[str, bool] = {}
    for address, family in cases:
        sentinel = socket.socket(family, socket.SOCK_DGRAM)
        try:
            sentinel.bind((address, 0))
        except OSError:
            sentinel.close()
            continue  # a kernel without that loopback address has nothing to refuse
        with sentinel:
            sentinel.settimeout(1.0)
            port = int(sentinel.getsockname()[1])
            send_datagram_as_engine(family, address, 0, address, port)
            arrived[address] = arrives(sentinel)

    assert arrived and not any(arrived.values()), arrived

    # The same send arrives from a user the rules do not name, so the refusal was the rules.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel:
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(2.0)
        done = run_as(
            STRANGER_UID,
            STRANGER_GID,
            SEND,
            str(int(socket.AF_INET)),
            "127.0.0.1",
            "0",
            "127.0.0.1",
            str(sentinel.getsockname()[1]),
        )
        assert done.returncode == 0, done.stderr
        assert arrives(sentinel)


# #244-T09
def test_the_engine_user_cannot_send_on_a_udp_flow_somebody_else_opened_and_closed() -> None:
    # The supervisor's own DNS lookups look like this: a datagram, an answer, the socket closed.
    # The connection tracker keeps that flow "established" for a while, and the same source port
    # is free again: a rule that accepts established flows would let the engine user send to the
    # sentinel on it. The rules were installed before this flow existed, as in production.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel:
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(1.0)
        sentinel_port = int(sentinel.getsockname()[1])
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as root_side:
            root_side.bind(("127.0.0.1", 0))
            root_side.settimeout(1.0)
            source_port = int(root_side.getsockname()[1])
            root_side.sendto(b"query", ("127.0.0.1", sentinel_port))
            _, client = sentinel.recvfrom(16)
            assert client == ("127.0.0.1", source_port)
            sentinel.sendto(b"answer", client)
            assert root_side.recvfrom(16)[0] == b"answer"  # the flow now has its reply
        send_datagram_as_engine(
            socket.AF_INET, "127.0.0.1", source_port, "127.0.0.1", sentinel_port
        )
        reused = arrives(sentinel)

    assert reused is False


# #244-T10
def test_the_probe_passes_against_the_static_rules_for_a_supervisor_without_net_admin() -> None:
    with slot_proxy() as proxy:
        verify_confinement(ENGINE_UID, ENGINE_GID, proxy)


# #244-T08
def test_nobody_in_the_container_can_read_or_change_the_rules_not_even_root() -> None:
    nft = shutil.which("nft", path="/usr/sbin:/sbin:" + TRUSTED_PATH)
    assert nft is not None
    attempts = [
        ["list", "tables"],
        ["list", "table", "inet", table_name(ENGINE_UID)],
        ["delete", "table", "inet", table_name(ENGINE_UID)],
        ["flush", "ruleset"],
        ["add", "table", "inet", "code_reviewer_probe"],
    ]
    # The supervisor itself (root, the process running this test) ...
    for arguments in attempts:
        done = subprocess.run([nft, *arguments], capture_output=True, text=True, timeout=30)
        assert done.returncode != 0, arguments
    # ... and the engine user.
    for arguments in attempts:
        done = run_as(
            ENGINE_UID,
            ENGINE_GID,
            "import subprocess, sys; sys.exit(subprocess.call(sys.argv[1:]))",
            nft,
            *arguments,
        )
        assert done.returncode != 0, arguments
