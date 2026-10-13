# SPDX-License-Identifier: Apache-2.0

"""The engine user's network, against the real kernel (#197-T04, #197-T09).

The rules are the production ones (`netguard.py`, nft). The proxy, "another job's proxy" and "an
external host" are loopback listeners the test owns, so each of them accepts a connection unless
the rules refuse it; the namespace has no route out, so a refusal can only be the rules at work.
"""

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
        confinement.apply([proxy, free_port()])
        try:
            engine = connect_as(ENGINE_UID, ENGINE_GID, targets)
            stranger = connect_as(STRANGER_UID, STRANGER_GID, targets)
        finally:
            confinement.remove()
        after = connect_as(ENGINE_UID, ENGINE_GID, targets)

    assert engine["proxy"]["connected"] is True
    for label in (target[0] for target in targets[1:]):
        assert engine[label]["connected"] is False, label
        # Refused, not a silent drop: a drop would run into the 2 s connect timeout of the probe.
        assert engine[label]["seconds"] < 1.9, label
    # The rules name one user: another job's user reaches everything, as before.
    assert all(result["connected"] for result in stranger.values())
    # Removing the rules gives the user its network back (the table is gone with the job).
    assert all(result["connected"] for result in after.values())
    assert table_name(ENGINE_UID) not in nft_tables()


# #197-T09
def test_datagrams_of_the_engine_user_are_refused_too() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sentinel, listener() as proxy:
        sentinel.bind(("127.0.0.1", 0))
        sentinel.settimeout(1.0)
        port = int(sentinel.getsockname()[1])
        send = (
            "import socket, sys; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); "
            "s.sendto(b'x', ('127.0.0.1', int(sys.argv[1])))"
        )
        confinement = NetworkConfinement(ENGINE_UID)
        confinement.apply([proxy, free_port()])
        try:
            run_as(ENGINE_UID, ENGINE_GID, send, str(port))
            try:
                sentinel.recvfrom(16)
                arrived_confined = True
            except OSError:
                arrived_confined = False
        finally:
            confinement.remove()
        run_as(ENGINE_UID, ENGINE_GID, send, str(port))
        sentinel.settimeout(2.0)
        sentinel.recvfrom(16)  # the same send arrives once the rules are gone

    assert arrived_confined is False


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
        confinement.apply([proxy, free_port()])
        try:
            verify_confinement(ENGINE_UID, ENGINE_GID, proxy)
        finally:
            confinement.remove()


# #197-T09
def test_applying_again_replaces_the_rules_of_the_user_and_does_not_stack_them() -> None:
    with listener() as proxy, listener() as second:
        confinement = NetworkConfinement(ENGINE_UID)
        confinement.apply([proxy, free_port()])
        confinement.apply([second, free_port()])
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
