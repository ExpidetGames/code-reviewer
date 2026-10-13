# SPDX-License-Identifier: Apache-2.0

"""The engine user's network, against the real kernel (#197-T04, #197-T09).

The rules are the production ones (`netguard.py`, nft). The proxy, "another job's proxy" and "an
external host" are loopback listeners the test owns, so each of them accepts a connection unless
the rules refuse it; the namespace has no route out, so a refusal can only be the rules at work.
"""

import errno
import socket
import time
from collections.abc import Generator
from contextlib import contextmanager

from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    STRANGER_GID,
    STRANGER_UID,
    connect_as,
    free_port,
    listener,
    nft_tables,
    run_as,
)

from code_reviewer_runner.dynamic_review.netguard import (
    NetworkConfinement,
    table_name,
    verify_confinement,
)

# What a refused connection looks like to the user: an immediate error from the reject, never a
# timeout (a silent drop). How long it takes is not part of that: a SYN retransmit may add a second.
REFUSED = {errno.EACCES, errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH}


@contextmanager
def optional_ipv6_listener() -> Generator[int | None]:
    try:
        with listener("::1", socket.AF_INET6) as port:
            yield port
    except OSError:
        yield None


# #197-T04 #197-T09
def test_the_engine_user_reaches_its_proxy_and_nothing_else_and_other_users_are_untouched() -> None:
    with (
        listener() as proxy,
        listener() as other_job,
        listener("127.0.0.2") as elsewhere,
        optional_ipv6_listener() as ipv6,
    ):
        targets = [
            ("proxy", "127.0.0.1", proxy),
            ("other job", "127.0.0.1", other_job),
            ("other address", "127.0.0.2", elsewhere),
        ]
        if ipv6 is not None:  # a kernel without IPv6 loopback has nothing to refuse
            targets.append(("ipv6 loopback", "::1", ipv6))
        confinement = NetworkConfinement(ENGINE_UID)
        confinement.apply(proxy, free_port())
        try:
            engine = connect_as(ENGINE_UID, ENGINE_GID, targets)
            stranger = connect_as(STRANGER_UID, STRANGER_GID, targets)
        finally:
            confinement.remove()
        after = connect_as(ENGINE_UID, ENGINE_GID, targets)

    assert engine["proxy"]["connected"] is True
    for label in (target[0] for target in targets[1:]):
        assert engine[label]["connected"] is False, label
        # Refused by the reject, not silently dropped (a drop ends in a timeout: no errno).
        assert engine[label]["errno"] in REFUSED, label
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


# #197-T09
def test_datagrams_of_the_engine_user_to_any_address_are_refused_and_flow_again_without_rules() -> (
    None
):
    cases = [
        ("127.0.0.1", socket.AF_INET),
        ("127.0.0.2", socket.AF_INET),
        ("::1", socket.AF_INET6),
    ]
    with listener() as proxy:
        confinement = NetworkConfinement(ENGINE_UID)
        confinement.apply(proxy, free_port())
        arrived: dict[str, bool] = {}
        try:
            for address, family in cases:
                try:
                    sentinel = socket.socket(family, socket.SOCK_DGRAM)
                    sentinel.bind((address, 0))
                except OSError:
                    sentinel.close()
                    continue  # a kernel without that loopback address has nothing to refuse
                with sentinel:
                    sentinel.settimeout(1.0)
                    port = int(sentinel.getsockname()[1])
                    send_datagram_as_engine(family, address, 0, address, port)
                    arrived[address] = arrives(sentinel)
        finally:
            confinement.remove()
    assert arrived and not any(arrived.values()), arrived

    # The same send arrives once the rules are gone, so the refusal above was the rules.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel:
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(2.0)
        send_datagram_as_engine(
            socket.AF_INET, "127.0.0.1", 0, "127.0.0.1", int(sentinel.getsockname()[1])
        )
        assert arrives(sentinel)


# #197-T09
def test_the_engine_user_cannot_send_on_a_udp_flow_somebody_else_opened_and_closed() -> None:
    # The supervisor's own DNS lookups look like this: a datagram, an answer, the socket closed.
    # The connection tracker keeps that flow "established" for a while, and the same source port
    # is free again: a rule that accepts established flows would let the engine user send to the
    # sentinel on it.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel, listener() as proxy:
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(1.0)
        sentinel_port = int(sentinel.getsockname()[1])
        confinement = NetworkConfinement(ENGINE_UID)
        confinement.apply(proxy, free_port())  # first: only flows seen from now on are tracked
        try:
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
        finally:
            confinement.remove()

    assert reused is False


# #197-T09
def test_the_production_proof_passes_with_the_rules_and_fails_closed_without_them() -> None:
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

        confinement = NetworkConfinement(ENGINE_UID)
        confinement.apply(proxy, free_port())
        try:
            verify_confinement(ENGINE_UID, ENGINE_GID, proxy)
        finally:
            confinement.remove()


# #197-T09
def test_applying_again_replaces_the_rules_of_the_user_and_does_not_stack_them() -> None:
    with listener() as proxy, listener() as second:
        confinement = NetworkConfinement(ENGINE_UID)
        confinement.apply(proxy, free_port())
        confinement.apply(second, free_port())
        try:
            reached = connect_as(
                ENGINE_UID,
                ENGINE_GID,
                [("first", "127.0.0.1", proxy), ("second", "127.0.0.1", second)],
            )
        finally:
            confinement.remove()

    assert reached["first"]["connected"] is False  # the first port was replaced, not added to
    assert reached["second"]["connected"] is True
