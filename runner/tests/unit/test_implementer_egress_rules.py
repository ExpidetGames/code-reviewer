# SPDX-License-Identifier: LicenseRef-Proprietary

"""The third loopback port of the engine user's static network rules (#763), without root.

An Implementer container installs the same rules as a Dynamic one plus one more accepted port, the
egress proxy's. Nothing else about them changes; without the port the text stays byte for byte what
it was (`test_dynamic_review_egress_modes.py`). What the kernel does with the rules is proven by the
privileged suite.
"""

from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review import static_isolation
from code_reviewer_runner.dynamic_review.netguard import (
    EgressMode,
    IsolationError,
    NetworkConfinement,
    ruleset,
    table_name,
)
from code_reviewer_runner.dynamic_review.static_isolation import (
    EGRESS_PORT_VARIABLE,
    NETWORK_VARIABLE,
    SlotPorts,
    require_ports_outside_ephemeral_range,
    secure_startup,
    slot_ports,
)

UID = 10101
LOOPBACK_RANGE = "32768\t60999\n"


@pytest.fixture(autouse=True)
def never_ask_the_real_kernel(monkeypatch: pytest.MonkeyPatch) -> None:
    def real_kernel() -> EgressMode:
        raise AssertionError("pass `detect` to secure_startup: a unit test must not run nft")

    monkeypatch.setattr(static_isolation, "select_egress_mode", real_kernel)


@pytest.fixture
def ephemeral(tmp_path: Path) -> Path:
    path = tmp_path / "ip_local_port_range"
    path.write_text(LOOPBACK_RANGE, encoding="ascii")
    return path


# #763-T06
@pytest.mark.parametrize("mode", list(EgressMode))
def test_the_egress_port_is_one_more_accepted_loopback_port_before_the_final_refusal(
    mode: EgressMode,
) -> None:
    without = ruleset(UID, 10180, 10181, mode).splitlines()
    with_egress = ruleset(UID, 10180, 10181, mode, egress_port=10182).splitlines()

    family = "inet" if mode is EgressMode.FULL else "ip"
    added = (
        f'add rule {family} {table_name(UID)} output meta skuid {UID} oifname "lo" '
        "ip daddr 127.0.0.1 tcp dport 10182 accept"
    )
    assert [line for line in with_egress if line not in without] == [added]
    assert with_egress[-2] == added and with_egress[-1] == without[-1]
    assert len([line for line in with_egress if line.endswith("accept")]) == 4


# #763-T06
@pytest.mark.parametrize(
    "ports",
    [(10180, 10181, 10180), (10180, 10181, 10181), (10180, 10181, 0), (10180, 10181, 65536)],
)
def test_an_egress_port_that_clashes_or_is_not_a_port_is_refused(
    ports: tuple[int, int, int],
) -> None:
    with pytest.raises(IsolationError):
        ruleset(UID, ports[0], ports[1], egress_port=ports[2])


# #763-T06
def test_the_confinement_installs_the_egress_port_when_given_one() -> None:
    scripts: list[str] = []

    NetworkConfinement(UID, run=scripts.append).apply(10180, 10181, 10182)

    assert scripts == [ruleset(UID, 10180, 10181, egress_port=10182)]


# #763-T06
def test_without_an_egress_port_a_dynamic_container_gets_the_rules_it_always_got() -> None:
    scripts: list[str] = []

    NetworkConfinement(UID, run=scripts.append).apply(10180, 10181)

    assert scripts == [ruleset(UID, 10180, 10181)]


# #763-T06
def test_the_slot_has_an_egress_port_only_in_a_registries_container() -> None:
    assert slot_ports({}) == SlotPorts(10180, 10181)
    assert slot_ports({}).egress is None
    assert slot_ports({NETWORK_VARIABLE: "none"}).egress is None
    assert slot_ports({NETWORK_VARIABLE: "none", EGRESS_PORT_VARIABLE: "10182"}).egress is None
    assert slot_ports({NETWORK_VARIABLE: "registries"}) == SlotPorts(10180, 10181, 10182)
    assert slot_ports({EGRESS_PORT_VARIABLE: "20002"}) == SlotPorts(10180, 10181, 20002)


# #763-T06
@pytest.mark.parametrize(
    "environment",
    [
        {NETWORK_VARIABLE: "all"},
        {EGRESS_PORT_VARIABLE: "80"},
        {EGRESS_PORT_VARIABLE: "40000"},
        {EGRESS_PORT_VARIABLE: "x"},
        {EGRESS_PORT_VARIABLE: "10180"},
        {EGRESS_PORT_VARIABLE: "10181"},
        {"RUNNER_DYNAMIC_ENGINE_PORT": "10182", NETWORK_VARIABLE: "registries"},
    ],
)
def test_unusable_egress_settings_are_an_isolation_failure(environment: dict[str, str]) -> None:
    with pytest.raises(IsolationError):
        slot_ports(environment)


# #763-T06
def test_the_egress_port_must_lie_outside_the_ephemeral_range_like_the_others(
    ephemeral: Path,
) -> None:
    require_ports_outside_ephemeral_range(SlotPorts(10180, 10181, 10182), ephemeral)
    with pytest.raises(IsolationError, match="ephemeral"):
        require_ports_outside_ephemeral_range(SlotPorts(10180, 10181, 40000), ephemeral)


# #763-T06
def test_startup_hands_the_egress_port_to_the_installer_and_only_then() -> None:
    asked: list[tuple[int, ...]] = []

    for ports in (SlotPorts(10180, 10181), SlotPorts(10180, 10181, 10182)):
        secure_startup(
            UID,
            ports,
            install=lambda *given: asked.append(given),
            drop=lambda: None,
            detect=lambda: EgressMode.FULL,
        )

    assert asked == [(10180, 10181), (10180, 10181, 10182)]


# #763-T06
def test_the_default_installer_writes_the_egress_port_into_the_ruleset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scripts: list[str] = []
    monkeypatch.setattr(
        static_isolation,
        "NetworkConfinement",
        lambda uid, mode: NetworkConfinement(uid, run=scripts.append, mode=mode),
    )

    setup = secure_startup(
        UID,
        SlotPorts(10180, 10181, 10182),
        drop=lambda: None,
        detect=lambda: EgressMode.FULL,
    )

    assert setup.rules_installed
    assert scripts == [ruleset(UID, 10180, 10181, egress_port=10182)]
