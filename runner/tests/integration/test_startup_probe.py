# SPDX-License-Identifier: LicenseRef-Proprietary

"""The startup probe of the self-check, on real loopback sockets (#202).

At startup no job exists, so the supervisor plays the model proxy: it listens on the slot's proxy
port and the probe, run as the engine user, must be able to reach exactly that. The confinement
check itself needs root and the nft rules (`tests/privileged`); here the socket handling is pinned:
the listener is ours while the probe runs, a stranger on the port fails it, and nothing is left.
"""

import socket

import pytest

from code_reviewer_runner.dynamic_review import self_check
from code_reviewer_runner.dynamic_review.netguard import PROXY_HOST, IsolationError


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind((PROXY_HOST, 0))
        return int(probe.getsockname()[1])


# #202-T01
def test_the_supervisor_listens_on_the_proxy_port_while_the_probe_runs_and_not_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = free_port()
    seen: list[tuple[int, int, int]] = []

    def confinement(uid: int, gid: int, allowed_port: int) -> None:
        seen.append((uid, gid, allowed_port))
        # The probe's "allowed" connection must reach a listener of ours.
        with socket.create_connection((PROXY_HOST, allowed_port), timeout=2):
            pass

    monkeypatch.setattr(self_check, "verify_confinement", confinement)

    self_check.startup_probe(10101, 10101, port)

    assert seen == [(10101, 10101, port)]
    # Released again: the job's own proxy can bind it.
    with socket.socket() as again:
        again.bind((PROXY_HOST, port))


# #202-T09: somebody else holding the slot's port means the slot is not clean.
def test_a_stranger_on_the_proxy_port_fails_the_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    def must_not_run(uid: int, gid: int, allowed_port: int) -> None:
        raise AssertionError("the confinement is not judged against a port a stranger holds")

    monkeypatch.setattr(self_check, "verify_confinement", must_not_run)
    with socket.socket() as stranger:
        stranger.bind((PROXY_HOST, 0))
        stranger.listen(1)

        with pytest.raises(IsolationError, match="not free"):
            self_check.startup_probe(10101, 10101, int(stranger.getsockname()[1]))


# #202-T01: a port that only has a closed connection waiting out its time (a job's proxy that just
# ended on the same slot port) is clean; only a live listener is a stranger.
def test_a_port_with_a_connection_in_time_wait_is_still_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def confinement(uid: int, gid: int, allowed_port: int) -> None:
        return None

    monkeypatch.setattr(self_check, "verify_confinement", confinement)
    with socket.socket() as old_server:
        old_server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        old_server.bind((PROXY_HOST, 0))
        old_server.listen(1)
        port = int(old_server.getsockname()[1])
        client = socket.create_connection((PROXY_HOST, port), timeout=2)
        connection, _ = old_server.accept()
        connection.close()  # the side that closes first keeps the port's TIME_WAIT
        client.close()

    self_check.startup_probe(10101, 10101, port)
