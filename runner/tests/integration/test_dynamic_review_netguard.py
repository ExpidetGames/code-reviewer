# SPDX-License-Identifier: Apache-2.0

"""The nft rules that confine the engine user to its model proxy (#197), as text and as a decision.

The rules themselves are exercised against the kernel by the privileged suite
(`tests/privileged`); here only what the runner builds and how it judges the probe is pinned.
"""

import json
import re
import socket

import pytest

from code_reviewer_runner.dynamic_review import netguard
from code_reviewer_runner.dynamic_review.netguard import (
    IsolationError,
    NetworkConfinement,
    ruleset,
    verify_confinement,
)
from code_reviewer_runner.result import ErrorCode

UID = 10101
GID = 10101


# #197-T09
def test_the_rules_let_one_user_reach_only_its_proxy_and_server_port_on_loopback() -> None:
    script = ruleset(UID, 41000, 41001)

    rules = [line for line in script.splitlines() if line.startswith("add rule")]
    assert len(rules) == 4
    assert all(f"meta skuid {UID}" in rule for rule in rules)
    # Replies are accepted only from the engine's own server port, on loopback; never "any
    # established flow" (a lingering UDP flow of somebody else would let the user send on it).
    assert re.search(
        r'oifname "lo" ip saddr 127\.0\.0\.1 ip daddr 127\.0\.0\.1 tcp sport 41001 '
        r"ct state established accept$",
        rules[0],
    )
    # The new connections: the proxy and the engine's own port, in separate rules, TCP only.
    assert re.search(r'oifname "lo" ip daddr 127\.0\.0\.1 tcp dport 41000 accept$', rules[1])
    assert re.search(r'oifname "lo" ip daddr 127\.0\.0\.1 tcp dport 41001 accept$', rules[2])
    # The last rule refuses everything else of that user, immediately (not a silent drop).
    assert rules[3].endswith(f"meta skuid {UID} reject with icmpx type admin-prohibited")
    assert "policy accept" in script  # other users, the supervisor included, are untouched
    assert script.index("flush table") < script.index("add rule")
    # No rule anywhere accepts by connection state alone.
    assert not any("ct state" in rule and "sport" not in rule for rule in rules)


# #197-T09
@pytest.mark.parametrize(
    ("uid", "proxy_port", "engine_port"),
    [
        (0, 4000, 4001),
        (-1, 4000, 4001),
        (UID, 0, 4001),
        (UID, 70000, 4001),
        (UID, -5, 4001),
        (UID, 4000, 0),
        (UID, 4000, 70000),
        (UID, 4000, 4000),  # one port cannot be both the proxy and the engine
    ],
)
def test_rules_are_refused_for_root_or_a_port_out_of_range_or_shared(
    uid: int, proxy_port: int, engine_port: int
) -> None:
    with pytest.raises(IsolationError):
        ruleset(uid, proxy_port, engine_port)


# #197-T09 #244-T01
def test_applying_twice_replaces_the_rules_of_this_users_table_and_never_deletes_it() -> None:
    scripts: list[str] = []
    confinement = NetworkConfinement(UID, run=scripts.append)

    confinement.apply(4000, 4002)
    confinement.apply(4000, 4001)

    assert len(scripts) == 2
    assert "flush table" in scripts[0] and "4001" in scripts[1]
    # The rules are static: the runner has no way to take them out again.
    assert not any("delete table" in script for script in scripts)
    assert not hasattr(confinement, "remove")


# #197-T09
def test_a_refused_ruleset_is_the_isolation_code_and_names_no_value() -> None:
    def refuse(script: str) -> None:
        raise IsolationError("the network filter was refused by the kernel")

    with pytest.raises(IsolationError) as caught:
        NetworkConfinement(UID, run=refuse).apply(4000, 4001)

    assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


def probe_that(reaches: dict[str, bool], sends_datagram: bool = False) -> netguard.ProbeRunner:
    """A probe that reports `reaches` and, optionally, really sends the datagram it was given."""

    def run(argv: list[str], uid: int, gid: int) -> str:
        assert (uid, gid) == (UID, GID)
        if sends_datagram:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
                sender.sendto(b"x", (argv[-7], int(argv[-2])))
        return json.dumps(reaches)

    return run


# #197-T09
def test_a_confined_user_passes_the_probe() -> None:
    verify_confinement(
        UID,
        GID,
        4000,
        run_probe=probe_that({"allowed": True, "other_port": False, "other_host": False}),
    )


# #197-T04 #197-T09
@pytest.mark.parametrize(
    "reaches",
    [
        {"allowed": False, "other_port": False, "other_host": False},
        {"allowed": True, "other_port": True, "other_host": False},
        {"allowed": True, "other_port": False, "other_host": True},
        {"allowed": True, "other_host": False},
    ],
)
def test_a_user_that_can_reach_anything_else_or_not_its_proxy_fails_closed(
    reaches: dict[str, bool],
) -> None:
    with pytest.raises(IsolationError):
        verify_confinement(UID, GID, 4000, run_probe=probe_that(reaches))


# #197-T09
def test_a_datagram_that_arrives_fails_closed() -> None:
    with pytest.raises(IsolationError, match="datagrams"):
        verify_confinement(
            UID,
            GID,
            4000,
            run_probe=probe_that(
                {"allowed": True, "other_port": False, "other_host": False}, sends_datagram=True
            ),
        )


# #197-T09
@pytest.mark.parametrize("output", ["", "not json", "[]", "null"])
def test_a_probe_without_a_result_fails_closed(output: str) -> None:
    with pytest.raises(IsolationError):
        verify_confinement(UID, GID, 4000, run_probe=lambda argv, uid, gid: output)


# #197-T09
def test_without_the_rules_a_real_probe_reaches_the_sentinels_and_the_check_fails_closed() -> None:
    # No filter is installed here: the probe runs as the current user and every sentinel accepts.
    # The check must not mistake "nothing blocked" for "confined".
    with socket.socket() as proxy:
        proxy.bind(("127.0.0.1", 0))
        proxy.listen(1)
        port = int(proxy.getsockname()[1])

        def run_locally(argv: list[str], uid: int, gid: int) -> str:
            import subprocess

            return subprocess.run(
                argv, capture_output=True, text=True, timeout=20, check=True
            ).stdout

        with pytest.raises(IsolationError, match="other than its model proxy"):
            verify_confinement(UID, GID, port, run_probe=run_locally)
