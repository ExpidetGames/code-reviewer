# SPDX-License-Identifier: Apache-2.0

"""The two egress rulesets of the engine user and the choice between them (#345), without root.

The full ruleset (`table inet`, `reject`) is what every host with a complete nf_tables gets and it
must not change. The fallback (`table ip`, `drop`, IPv6 switched off) exists for kernels that
support only the `ip` family. What the kernel really does with either is proven by the privileged
suite; here the text of the rules, the detection and the guard around the mode are pinned.
"""

import re
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review import netguard
from code_reviewer_runner.dynamic_review.netguard import (
    EGRESS_MODE_VARIABLE,
    EgressMode,
    IsolationError,
    NetworkConfinement,
    NftRefused,
    NftUnavailable,
    egress_mode_from_environment,
    inet_reject_supported,
    ruleset,
    select_egress_mode,
    table_family,
    table_name,
)

UID = 10101


class Kernel:
    """A stand-in for `nft -f -`: records the scripts and refuses what a given kernel refuses."""

    def __init__(self, *, refuses: tuple[str, ...] = (), unavailable: bool = False) -> None:
        self.scripts: list[str] = []
        self.refuses = refuses
        self.unavailable = unavailable

    def __call__(self, script: str) -> None:
        self.scripts.append(script)
        if self.unavailable:
            raise NftUnavailable("the network filter tool is not installed")
        if any(word in script for word in self.refuses):
            raise NftRefused("the network filter was refused by the kernel")


# #345-T01
def test_a_kernel_that_accepts_inet_with_reject_gets_the_full_mode_and_no_probe_is_left() -> None:
    kernel = Kernel()

    assert inet_reject_supported(kernel) is True
    assert select_egress_mode(kernel) is EgressMode.FULL
    # The probe asks for exactly what the full ruleset needs, and takes its table away again.
    assert "table inet" in kernel.scripts[0] and "reject with icmpx" in kernel.scripts[0]
    assert kernel.scripts[1].startswith("delete table inet ")
    assert kernel.scripts[1].split()[-1] in kernel.scripts[0]


# #345-T02
@pytest.mark.parametrize("missing", ["inet", "reject"])
def test_a_kernel_without_inet_or_without_reject_gets_the_fallback_mode(missing: str) -> None:
    kernel = Kernel(refuses=(missing,))

    assert select_egress_mode(kernel) is EgressMode.FALLBACK


# #345-T02
def test_a_probe_table_that_is_left_behind_by_a_failed_delete_does_not_change_the_answer() -> None:
    class Stubborn(Kernel):
        def __call__(self, script: str) -> None:
            super().__call__(script)
            if script.startswith("delete"):
                raise NftRefused("no")

    assert select_egress_mode(Stubborn()) is EgressMode.FULL


# #345-T02
def test_a_missing_nft_tool_is_not_a_kernel_without_inet() -> None:
    # No tool means no rules in either mode; picking the fallback would only switch IPv6 off for
    # nothing. The startup step reports the missing tool as the reason the rules are not installed.
    with pytest.raises(NftUnavailable):
        select_egress_mode(Kernel(unavailable=True))


# #345-T03
def test_the_full_ruleset_is_the_inet_reject_one_it_always_was() -> None:
    text = ruleset(UID, 10180, 10181)

    assert text == ruleset(UID, 10180, 10181, EgressMode.FULL)
    assert f"add table inet {table_name(UID)}" in text
    assert f"flush table inet {table_name(UID)}" in text
    assert text.rstrip().endswith(f"meta skuid {UID} reject with icmpx type admin-prohibited")
    assert table_family(EgressMode.FULL) == "inet"
    assert len([line for line in text.splitlines() if line.endswith("accept")]) == 3


# #345-T19
def test_the_full_ruleset_text_is_byte_for_byte_what_hosts_with_inet_always_got() -> None:
    table = "code_reviewer_engine_10101"
    assert ruleset(10101, 10180, 10181) == (
        f"add table inet {table}\n"
        f"flush table inet {table}\n"
        f"add chain inet {table} output "
        "{ type filter hook output priority 0 ; policy accept ; }\n"
        f'add rule inet {table} output meta skuid 10101 oifname "lo" ip saddr 127.0.0.1 '
        "ip daddr 127.0.0.1 tcp sport 10181 ct state established accept\n"
        f'add rule inet {table} output meta skuid 10101 oifname "lo" ip daddr 127.0.0.1 '
        "tcp dport 10180 accept\n"
        f'add rule inet {table} output meta skuid 10101 oifname "lo" ip daddr 127.0.0.1 '
        "tcp dport 10181 accept\n"
        f"add rule inet {table} output meta skuid 10101 "
        "reject with icmpx type admin-prohibited\n"
    )


# #345-T04
def test_the_fallback_ruleset_is_ip_only_drops_the_rest_and_allows_the_same_three_things() -> None:
    full = ruleset(UID, 10180, 10181, EgressMode.FULL).splitlines()
    text = ruleset(UID, 10180, 10181, EgressMode.FALLBACK)
    lines = text.splitlines()

    assert table_family(EgressMode.FALLBACK) == "ip"
    assert "inet" not in text and "reject" not in text and "ip6" not in text
    assert all(line.split()[2] == "ip" for line in lines if line)
    assert lines[-1] == f"add rule ip {table_name(UID)} output meta skuid {UID} drop"
    # The accepts are the full ruleset's, line for line, in the other family.
    accepts = [line for line in lines if line.endswith("accept")]
    assert accepts == [line.replace("inet", "ip", 1) for line in full if line.endswith("accept")]
    assert len(accepts) == 3
    assert re.findall(r"tcp dport (\d+)", text) == ["10180", "10181"]


# #345-T04
@pytest.mark.parametrize("mode", list(EgressMode))
@pytest.mark.parametrize(
    ("uid", "proxy", "engine"),
    [
        (0, 10180, 10181),
        (-1, 10180, 10181),
        (10101, 0, 10181),
        (10101, 10180, 70000),
        (10101, 10180, 10180),
    ],
)
def test_both_rulesets_refuse_root_a_port_out_of_range_or_one_port_for_both(
    mode: EgressMode, uid: int, proxy: int, engine: int
) -> None:
    with pytest.raises(IsolationError):
        ruleset(uid, proxy, engine, mode)


# #345-T04
def test_applying_installs_the_ruleset_of_the_mode_it_was_made_for() -> None:
    for mode in EgressMode:
        kernel = Kernel()
        NetworkConfinement(UID, run=kernel, mode=mode).apply(10180, 10181)
        assert kernel.scripts == [ruleset(UID, 10180, 10181, mode)]
    # Without a mode it is the full one: nothing that already installed rules changes.
    kernel = Kernel()
    NetworkConfinement(UID, run=kernel).apply(10180, 10181)
    assert kernel.scripts == [ruleset(UID, 10180, 10181, EgressMode.FULL)]


# #345-T12
def test_a_job_process_gets_the_mode_the_loop_decided_and_missing_means_full() -> None:
    assert egress_mode_from_environment({}) is EgressMode.FULL
    assert egress_mode_from_environment({EGRESS_MODE_VARIABLE: "full"}) is EgressMode.FULL
    assert egress_mode_from_environment({EGRESS_MODE_VARIABLE: "fallback"}) is EgressMode.FALLBACK


# #345-T12
@pytest.mark.parametrize("value", ["", "FALLBACK", "inet", "none", "fallback ", "0"])
def test_a_mode_nobody_defined_is_an_isolation_failure(value: str) -> None:
    with pytest.raises(IsolationError):
        egress_mode_from_environment({EGRESS_MODE_VARIABLE: value})


# #345-T11
def test_the_module_reads_no_environment_variable_by_itself() -> None:
    # The mode is decided by the kernel (or by a test through the seam of the startup step), and
    # handed on by the loop. Nothing in the module looks at the process environment.
    source = netguard.__loader__.get_source(netguard.__name__)  # type: ignore[union-attr]
    assert source is not None
    assert "os.environ" not in source and "getenv" not in source


# #345-T11
def test_nothing_in_the_runner_can_force_a_mode_only_the_kernel_and_the_loop_decide() -> None:
    # The privileged suite forces the fallback by passing `detect` to `secure_startup` and reads
    # its switch itself. In the runner no module passes `detect`, names that switch, or reads the
    # mode from anywhere but the kernel's answer (startup) and the loop's hand-over (job process).
    source_root = Path(netguard.__file__).parents[1]
    forcing: list[str] = []
    for path in source_root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(source_root).as_posix()
        if "CR_PRIVILEGED_EGRESS_MODE" in text or "CR_FORCE" in text:
            forcing.append(f"{relative}: a test switch")
        if re.search(r"\bdetect\s*=", text) and relative != "dynamic_review/static_isolation.py":
            forcing.append(f"{relative}: passes detect")
        if re.search(r"(os\.environ|getenv)[^\n]*EGRESS|EGRESS[^\n]*(os\.environ|getenv)", text):
            forcing.append(f"{relative}: reads the environment for the mode")
    assert forcing == []

    startup = (source_root / "dynamic_review" / "static_isolation.py").read_text(encoding="utf-8")
    assert "os.environ" not in startup and "getenv" not in startup
    service = (source_root / "job_loop" / "service.py").read_text(encoding="utf-8")
    assert "detect" not in service


def test_modes_have_stable_names() -> None:
    assert [mode.value for mode in EgressMode] == ["full", "fallback"]
    assert EGRESS_MODE_VARIABLE == "RUNNER_EGRESS_MODE"
