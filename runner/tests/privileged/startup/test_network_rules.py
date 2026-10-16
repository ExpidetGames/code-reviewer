# SPDX-License-Identifier: Apache-2.0

"""The engine user's nft rules as such, against the real kernel (#197-T04, #197-T09, #345).

Every test runs for both rulesets (#345): the full one (`table inet`, `reject`: an immediate
refusal, asserted strictly) and the fallback (`table ip`, `drop`, IPv6 switched off by the same
production step: a refusal or a timeout). The kernel of the CI host supports both.

This is the startup phase (it needs `NET_ADMIN`, which the job phase no longer holds): the rules are
installed and taken out here the way `static_isolation` installs them once at container start. That
they still hold for a supervisor without `NET_ADMIN` is proven in the job phase
(`test_static_rules.py`). The rules are the production ones (`netguard.py`, nft). The proxy,
"another job's proxy" and "an external host" are loopback listeners the test owns, so each of them
accepts a connection unless the rules refuse it; the namespace has no route out, so a refusal can
only be the rules at work.
"""

import shutil
import socket
import time
from collections.abc import Generator
from contextlib import contextmanager

import pytest
from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    STRANGER_GID,
    STRANGER_UID,
    blocked,
    connect_as,
    free_port,
    installed_rules,
    listener,
    nft_tables,
    run_as,
)

from code_reviewer_runner.dynamic_review.netguard import (
    EgressMode,
    NetworkConfinement,
    table_family,
    table_name,
    verify_confinement,
)

BOTH_MODES = pytest.mark.parametrize("mode", list(EgressMode), ids=lambda mode: mode.value)


@contextmanager
def optional_ipv6_listener(mode: EgressMode) -> Generator[int | None]:
    # The fallback runs with IPv6 off, so there is no IPv6 loopback to refuse (its own tests:
    # `test_fallback_ipv6.py`).
    if mode is EgressMode.FALLBACK:
        yield None
        return
    try:
        with listener("::1", socket.AF_INET6) as port:
            yield port
    except OSError:
        yield None


# #197-T04 #197-T09 #345-T14 #345-T17
@BOTH_MODES
def test_the_engine_user_reaches_its_proxy_and_nothing_else_and_other_users_are_untouched(
    mode: EgressMode,
) -> None:
    with (
        listener() as proxy,
        listener() as other_job,
        listener("127.0.0.2") as elsewhere,
        optional_ipv6_listener(mode) as ipv6,
    ):
        targets = [
            ("proxy", "127.0.0.1", proxy),
            ("other job", "127.0.0.1", other_job),
            ("other address", "127.0.0.2", elsewhere),
        ]
        if ipv6 is not None:  # a kernel without IPv6 loopback has nothing to refuse
            targets.append(("ipv6 loopback", "::1", ipv6))
        with installed_rules(proxy, free_port(), mode):
            engine = connect_as(ENGINE_UID, ENGINE_GID, targets)
            stranger = connect_as(STRANGER_UID, STRANGER_GID, targets)
        after = connect_as(ENGINE_UID, ENGINE_GID, targets)

    assert engine["proxy"]["connected"] is True
    for label in (target[0] for target in targets[1:]):
        assert engine[label]["connected"] is False, label
        # Full mode: refused by the reject, not silently dropped (a drop ends in a timeout, no
        # errno): the strict assertion. Fallback mode: a drop, so a timeout is expected as well.
        assert blocked(engine[label], mode), label
    # The rules name one user: another job's user reaches everything, as before.
    assert all(result["connected"] for result in stranger.values())
    # Removing the rules gives the user its network back (the table is gone with the job).
    assert all(result["connected"] for result in after.values())
    assert table_name(ENGINE_UID) not in nft_tables()


SEND = (
    "import socket, sys; "
    "s = socket.socket(int(sys.argv[1]), socket.SOCK_DGRAM); "
    "s.bind((sys.argv[2], int(sys.argv[3]))); "
    "s.sendto(b'x', (sys.argv[4], int(sys.argv[5])))"
)


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


# #197-T09 #345-T15
@BOTH_MODES
def test_datagrams_of_the_engine_user_to_any_address_are_refused_and_flow_again_without_rules(
    mode: EgressMode,
) -> None:
    cases = [
        ("127.0.0.1", socket.AF_INET),
        ("127.0.0.2", socket.AF_INET),
        ("::1", socket.AF_INET6),
    ]
    with listener() as proxy, installed_rules(proxy, free_port(), mode):
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

    # The same send arrives once the rules are gone, so the refusal above was the rules.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel:
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(2.0)
        send_datagram_as_engine(
            socket.AF_INET, "127.0.0.1", 0, "127.0.0.1", int(sentinel.getsockname()[1])
        )
        assert arrives(sentinel)


# #197-T09 #345-T15
@BOTH_MODES
def test_the_engine_user_cannot_send_on_a_udp_flow_somebody_else_opened_and_closed(
    mode: EgressMode,
) -> None:
    # The supervisor's own DNS lookups look like this: a datagram, an answer, the socket closed.
    # The connection tracker keeps that flow "established" for a while, and the same source port
    # is free again: a rule that accepts established flows would let the engine user send to the
    # sentinel on it.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel, listener() as proxy:
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(1.0)
        sentinel_port = int(sentinel.getsockname()[1])
        # First the rules: only flows seen from now on are tracked.
        with installed_rules(proxy, free_port(), mode):
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


# #197-T09 #345-T14
@BOTH_MODES
def test_the_production_proof_passes_with_the_rules_and_fails_closed_without_them(
    mode: EgressMode,
) -> None:
    with listener() as proxy:
        # No rules: every sentinel accepts, so the proof must refuse to call this confined.
        started = time.monotonic()
        try:
            verify_confinement(ENGINE_UID, ENGINE_GID, proxy)
        except Exception as error:
            unconfined = str(error)
        else:
            unconfined = ""
        assert "other than its model proxy" in unconfined
        assert time.monotonic() - started < 30

        with installed_rules(proxy, free_port(), mode):
            verify_confinement(ENGINE_UID, ENGINE_GID, proxy)


# #197-T09 #345-T14
@BOTH_MODES
def test_applying_again_replaces_the_rules_of_the_user_and_does_not_stack_them(
    mode: EgressMode,
) -> None:
    with listener() as proxy, listener() as second, installed_rules(proxy, free_port(), mode):
        NetworkConfinement(ENGINE_UID, mode=mode).apply(second, free_port())
        reached = connect_as(
            ENGINE_UID,
            ENGINE_GID,
            [("first", "127.0.0.1", proxy), ("second", "127.0.0.1", second)],
        )

    assert reached["first"]["connected"] is False  # the first port was replaced, not added to
    assert reached["second"]["connected"] is True


# #197-T09 #345-T14
@BOTH_MODES
def test_the_engine_user_cannot_change_the_rules_that_confine_it(mode: EgressMode) -> None:
    nft = shutil.which("nft", path="/usr/sbin:/sbin:/usr/bin:/bin")
    assert nft is not None
    with listener() as proxy, installed_rules(proxy, free_port(), mode):
        listing = run_as(
            ENGINE_UID,
            ENGINE_GID,
            "import subprocess, sys; sys.exit(subprocess.call([sys.argv[1], 'list', 'tables']))",
            nft,
        )
        flushing = run_as(
            ENGINE_UID,
            ENGINE_GID,
            "import subprocess, sys; "
            "sys.exit(subprocess.call([sys.argv[1], 'delete', 'table', sys.argv[2], sys.argv[3]]))",
            nft,
            table_family(mode),
            table_name(ENGINE_UID),
        )
        still_there = table_name(ENGINE_UID) in nft_tables()

    assert listing.returncode != 0
    assert flushing.returncode != 0
    assert still_there


MAPPED = (
    "import socket, sys; "
    "s = socket.socket(socket.AF_INET6); s.settimeout(2); "
    "s.connect(('::ffff:' + sys.argv[1], int(sys.argv[2])))"
)


# #345-T15
@BOTH_MODES
def test_an_ipv6_socket_to_a_mapped_ipv4_address_is_confined_like_ipv4(mode: EgressMode) -> None:
    # A dual-stack socket sends IPv4 packets for `::ffff:a.b.c.d`; they meet the same rules. This
    # matters most for the fallback, whose table is IPv4 only.
    with (
        listener() as proxy,
        listener("127.0.0.2") as elsewhere,
        installed_rules(proxy, free_port(), mode),
    ):
        engine = run_as(ENGINE_UID, ENGINE_GID, MAPPED, "127.0.0.2", str(elsewhere))
        stranger = run_as(STRANGER_UID, STRANGER_GID, MAPPED, "127.0.0.2", str(elsewhere))

    assert engine.returncode != 0
    if mode is EgressMode.FULL:  # IPv6 is on there: the same call from an unconfined user works
        assert stranger.returncode == 0, stranger.stderr
