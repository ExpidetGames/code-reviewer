# SPDX-License-Identifier: Apache-2.0

"""The one-time network setup of the Dynamic runner and the end of NET_ADMIN (#244), without root.

The syscalls themselves (the bounding-set drop, `capset`) and the effect on a real process are
proven as root by the privileged suite (`tests/privileged/startup`); here the order, the failure
behaviour and the reading of a capability status are pinned.
"""

import _thread
import inspect
import logging
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review import static_isolation
from code_reviewer_runner.dynamic_review.netguard import EgressMode, IsolationError, NftUnavailable
from code_reviewer_runner.dynamic_review.static_isolation import (
    CAP_NET_ADMIN,
    CAP_SETPCAP,
    EgressSetup,
    SlotPorts,
    capability_sets,
    require_startup_capabilities_gone,
    secure_startup,
    sets_holding_startup_capabilities,
    slot_ports,
)
from code_reviewer_runner.job_loop.service import prepare_dynamic_runtime
from code_reviewer_runner.job_loop.settings import LoopSettings
from code_reviewer_runner.result import ErrorCode

PORTS = SlotPorts(10180, 10181)


@pytest.fixture(autouse=True)
def never_ask_the_real_kernel(monkeypatch: pytest.MonkeyPatch) -> None:
    """The startup step decides its mode from the kernel; a unit test must always say which."""

    def real_kernel() -> EgressMode:
        raise AssertionError("pass `detect` to secure_startup: a unit test must not run nft")

    monkeypatch.setattr(static_isolation, "select_egress_mode", real_kernel)


def status(bounding: int = 0, **sets: int) -> str:
    """A /proc/<pid>/status excerpt; every set is empty unless given."""
    values = {"CapInh": 0, "CapPrm": 0, "CapEff": 0, "CapBnd": bounding, "CapAmb": 0, **sets}
    return "Name:\tx\n" + "".join(f"{name}:\t{value:016x}\n" for name, value in values.items())


# #244-T05
def test_the_startup_installs_the_rules_for_the_slot_first_and_drops_the_capabilities_after() -> (
    None
):
    events: list[str] = []

    installed = secure_startup(
        10101,
        PORTS,
        install=lambda proxy, engine: events.append(f"install:{proxy}:{engine}"),
        drop=lambda: events.append("drop"),
        detect=lambda: EgressMode.FULL,
    )

    assert installed.rules_installed is True
    assert events == ["install:10180:10181", "drop"]


# #244-T05
def test_rules_that_cannot_be_installed_still_end_net_admin_and_report_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    events: list[str] = []

    def refuse(proxy: int, engine: int) -> None:
        raise IsolationError("the network filter tool is not installed")

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        installed = secure_startup(
            10101,
            PORTS,
            install=refuse,
            drop=lambda: events.append("drop"),
            detect=lambda: EgressMode.FULL,
        )

    # The runner keeps serving Diff jobs without the capability; Dynamic jobs fail their probe.
    assert installed.rules_installed is False
    assert events == ["drop"]
    assert ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED.value in caplog.text


# #244-T05
def test_a_drop_that_fails_is_never_swallowed() -> None:
    def cannot_drop() -> None:
        raise IsolationError("a capability could not be dropped from the bounding set")

    with pytest.raises(IsolationError) as caught:
        secure_startup(
            10101,
            PORTS,
            install=lambda proxy, engine: None,
            drop=cannot_drop,
            detect=lambda: EgressMode.FULL,
        )

    assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


# #244-T05
def test_the_drop_is_refused_once_another_thread_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    # Capability sets belong to a thread and a new thread copies its creator's.
    monkeypatch.setattr(static_isolation.threading, "active_count", lambda: 2)

    with pytest.raises(IsolationError, match="threads"):
        static_isolation.drop_startup_capabilities()


# #244-T05
def test_the_drop_is_refused_once_a_native_thread_exists(tmp_path: Path) -> None:
    # `threading.active_count()` knows only threads Python started. Capability sets are per OS
    # thread, so the OS's own list of threads is what has to hold exactly one.
    tasks = tmp_path / "task"
    (tasks / "1").mkdir(parents=True)
    (tasks / "2").mkdir()

    with pytest.raises(IsolationError, match="threads"):
        static_isolation.drop_startup_capabilities(task_directory=tasks)


# #244-T05
def test_a_thread_started_below_the_threading_module_also_refuses_the_drop() -> None:
    # `_thread` threads are not in `threading.active_count()`, like a thread of a C extension.
    release = _thread.allocate_lock()
    release.acquire()
    _thread.start_new_thread(release.acquire, ())
    try:
        with pytest.raises(IsolationError, match="threads"):
            static_isolation.drop_startup_capabilities()
    finally:
        release.release()


# #244-T05
def test_a_thread_list_that_cannot_be_read_refuses_the_drop(tmp_path: Path) -> None:
    with pytest.raises(IsolationError, match="threads"):
        static_isolation.drop_startup_capabilities(task_directory=tmp_path / "missing")


# #244-T06
def test_a_process_with_either_capability_in_any_set_is_found() -> None:
    clean = status(bounding=0x1FFFFFFFFFF & ~(1 << CAP_NET_ADMIN) & ~(1 << CAP_SETPCAP))
    assert sets_holding_startup_capabilities(clean) == []
    require_startup_capabilities_gone(clean)

    for number in (CAP_NET_ADMIN, CAP_SETPCAP):
        for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
            holding = status(**{name: 1 << number})
            assert sets_holding_startup_capabilities(holding) == [name]
            with pytest.raises(IsolationError):
                require_startup_capabilities_gone(holding)


# #244-T06
def test_a_status_that_cannot_be_read_counts_as_holding_them() -> None:
    assert capability_sets("CapBnd:\tzz\nCapEff:\t0\n") == {"CapEff": 0}
    assert set(sets_holding_startup_capabilities("Name:\tx\n")) == {
        "CapInh",
        "CapPrm",
        "CapEff",
        "CapBnd",
        "CapAmb",
    }
    with pytest.raises(IsolationError):
        require_startup_capabilities_gone("")


# #244-T04
def test_the_slot_ports_are_fixed_distinct_and_below_the_ephemeral_range() -> None:
    assert slot_ports({}) == PORTS
    assert slot_ports({"RUNNER_DYNAMIC_PROXY_PORT": "1024", "RUNNER_DYNAMIC_ENGINE_PORT": "32767"})
    for bad in ("0", "1023", "32768", "-5", "1e3", "http"):
        with pytest.raises(IsolationError):
            slot_ports({"RUNNER_DYNAMIC_PROXY_PORT": bad})
    with pytest.raises(IsolationError):
        slot_ports({"RUNNER_DYNAMIC_ENGINE_PORT": "10180"})


def range_file(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "ip_local_port_range"
    path.write_text(text, encoding="ascii")
    return path


# #244-T04
def test_ports_inside_the_kernels_ephemeral_range_are_refused(tmp_path: Path) -> None:
    # The range can be lowered (a sysctl, a container option); the fixed ports must stay outside.
    static_isolation.require_ports_outside_ephemeral_range(
        PORTS, range_file(tmp_path, "32768\t60999\n")
    )
    for text in ("10181\t60999\n", "1024\t65535\n", "10180\t10180\n", "9000\t10181\n"):
        with pytest.raises(IsolationError) as caught:
            static_isolation.require_ports_outside_ephemeral_range(
                PORTS, range_file(tmp_path, text)
            )
        assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED


# #244-T04
def test_an_ephemeral_range_that_cannot_be_read_is_refused(tmp_path: Path) -> None:
    for text in ("", "32768\n", "a b\n", "60999 32768\n"):
        with pytest.raises(IsolationError):
            static_isolation.require_ports_outside_ephemeral_range(
                PORTS, range_file(tmp_path, text)
            )
    with pytest.raises(IsolationError):
        static_isolation.require_ports_outside_ephemeral_range(PORTS, tmp_path / "missing")


# #244-T04
def test_ports_in_the_ephemeral_range_install_nothing_but_still_end_net_admin(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    events: list[str] = []

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        installed = secure_startup(
            10101,
            PORTS,
            install=lambda proxy, engine: events.append("install"),
            drop=lambda: events.append("drop"),
            ephemeral_range=range_file(tmp_path, "10000\t60999\n"),
        )

    assert installed.rules_installed is False
    assert events == ["drop"]
    assert ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED.value in caplog.text


# #244-T05
def test_rules_that_cannot_be_installed_are_logged_once_at_error_level(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def refuse(proxy: int, engine: int) -> None:
        raise IsolationError("the network filter tool is not installed")

    def startup(uid: int, ports: SlotPorts) -> EgressSetup:
        return secure_startup(
            uid, ports, install=refuse, drop=lambda: None, detect=lambda: EgressMode.FULL
        )

    with caplog.at_level(logging.DEBUG, logger="code_reviewer_runner.loop"):
        prepare_dynamic_runtime(settings((10101, 10101), PORTS), startup=startup)

    assert [record.levelno for record in caplog.records] == [logging.ERROR]


def settings(
    engine_user: tuple[int, int] | None = None, ports: SlotPorts | None = None
) -> LoopSettings:
    return LoopSettings(
        api_url="http://app",
        token="t",
        runner_id="r",
        dynamic_engine_user=engine_user,
        dynamic_ports=ports,
    )


# #244-T05
def test_the_loop_runs_the_startup_only_on_a_root_loop_with_an_engine_user() -> None:
    calls: list[tuple[int, SlotPorts]] = []

    def startup(uid: int, ports: SlotPorts) -> EgressSetup:
        calls.append((uid, ports))
        return EgressSetup(True, EgressMode.FULL)

    prepare_dynamic_runtime(settings(), startup=startup)  # a Diff-only runner
    assert calls == []

    prepare_dynamic_runtime(settings((10101, 10101), PORTS), startup=startup)
    assert calls == [(10101, PORTS)]


# #244-T05
def test_a_runner_whose_capabilities_cannot_be_dropped_does_not_start() -> None:
    def broken(uid: int, ports: SlotPorts) -> EgressSetup:
        raise IsolationError("a capability could not be dropped from the bounding set")

    with pytest.raises(IsolationError):
        prepare_dynamic_runtime(settings((10101, 10101), PORTS), startup=broken)


# -- the two egress modes (#345) ----------------------------------------------


def startup_events(mode: EgressMode, events: list[str], **options: object) -> EgressSetup:
    """The startup step with the mode forced through its seam, every effect recorded."""
    return secure_startup(
        10101,
        PORTS,
        detect=lambda: mode,
        disable_ipv6=lambda: events.append("disable_ipv6"),
        ipv6_problem=lambda: None,
        install=lambda proxy, engine: events.append(f"install:{mode.value}"),
        drop=lambda: events.append("drop"),
        **options,  # type: ignore[arg-type]
    )


# #345-T05
def test_full_mode_installs_without_touching_ipv6_logs_it_and_still_drops(
    caplog: pytest.LogCaptureFixture,
) -> None:
    events: list[str] = []

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        setup = startup_events(EgressMode.FULL, events)

    assert setup == EgressSetup(True, EgressMode.FULL)
    assert events == ["install:full", "drop"]
    assert "egress rules: full (inet)" in caplog.text


# #345-T05
def test_fallback_mode_installs_the_rules_then_switches_ipv6_off_logs_it_and_still_drops(
    caplog: pytest.LogCaptureFixture,
) -> None:
    events: list[str] = []

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        setup = startup_events(EgressMode.FALLBACK, events)

    assert setup == EgressSetup(True, EgressMode.FALLBACK)
    # No engine runs at startup, so the order costs nothing; it keeps a failed install from
    # touching IPv6 (below).
    assert events == ["install:fallback", "disable_ipv6", "drop"]
    assert "egress rules: fallback (ip, ipv6 disabled)" in caplog.text


# #345-T06: from the review of the first push: rules that cannot be installed must not leave the
# whole container, Diff jobs included, without IPv6.
def test_fallback_rules_that_cannot_be_installed_leave_ipv6_alone() -> None:
    events: list[str] = []

    def refuse(proxy: int, engine: int) -> None:
        raise IsolationError("the network filter was refused by the kernel")

    setup = secure_startup(
        10101,
        PORTS,
        detect=lambda: EgressMode.FALLBACK,
        disable_ipv6=lambda: events.append("disable_ipv6"),
        install=refuse,
        drop=lambda: events.append("drop"),
    )

    assert setup == EgressSetup(False, EgressMode.FALLBACK)
    assert events == ["drop"]


# #345-T06
def test_ipv6_that_stays_on_is_logged_as_an_error_and_never_as_disabled(
    caplog: pytest.LogCaptureFixture,
) -> None:
    events: list[str] = []

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        setup = secure_startup(
            10101,
            PORTS,
            detect=lambda: EgressMode.FALLBACK,
            disable_ipv6=lambda: events.append("disable_ipv6"),
            ipv6_problem=lambda: "IPv6 is not switched off on every interface",
            install=lambda proxy, engine: events.append("install"),
            drop=lambda: events.append("drop"),
        )

    # No crash and no early stop: the runner keeps serving Diff jobs, the self-check refuses
    # Dynamic ones, and the log says why.
    assert setup == EgressSetup(True, EgressMode.FALLBACK)
    assert events == ["install", "disable_ipv6", "drop"]
    assert "ipv6 disabled" not in caplog.text
    errors = [record for record in caplog.records if record.levelno >= logging.ERROR]
    assert len(errors) == 1 and "IPv6 is not switched off" in errors[0].getMessage()


# #345-T05
def test_a_missing_nft_tool_installs_nothing_and_does_not_switch_ipv6_off(
    caplog: pytest.LogCaptureFixture,
) -> None:
    events: list[str] = []

    def no_tool() -> EgressMode:
        raise NftUnavailable("the network filter tool is not installed")

    with caplog.at_level(logging.INFO, logger="code_reviewer_runner.loop"):
        setup = secure_startup(
            10101,
            PORTS,
            detect=no_tool,
            disable_ipv6=lambda: events.append("disable_ipv6"),
            install=lambda proxy, engine: events.append("install"),
            drop=lambda: events.append("drop"),
        )

    assert setup.rules_installed is False
    assert events == ["drop"]
    assert "egress rules:" not in caplog.text


# #345-T05
def test_the_ports_are_checked_before_the_kernel_is_asked_anything() -> None:
    asked: list[str] = []
    inside = SlotPorts(40000, 40001)

    def detect() -> EgressMode:
        asked.append("detect")
        return EgressMode.FULL

    setup = secure_startup(
        10101,
        inside,
        detect=detect,
        install=lambda proxy, engine: asked.append("install"),
        drop=lambda: None,
        ephemeral_range=Path(__file__),  # not a range: unreadable counts as unsafe
    )

    assert setup.rules_installed is False
    assert asked == []


# #345-T11
def test_no_environment_variable_picks_the_egress_mode_at_startup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The only ways to a mode are the kernel's answer and the `detect` seam of this function,
    # which nothing but a test passes. Names a person might guess for a switch change nothing.
    for name in (
        "RUNNER_EGRESS_MODE",
        "RUNNER_DYNAMIC_EGRESS_MODE",
        "CR_FORCE_EGRESS_FALLBACK",
        "CR_EGRESS_MODE",
        "EGRESS_MODE",
    ):
        monkeypatch.setenv(name, "fallback")
    events: list[str] = []

    setup = secure_startup(
        10101,
        PORTS,
        detect=lambda: EgressMode.FULL,
        install=lambda proxy, engine: events.append("install"),
        drop=lambda: events.append("drop"),
    )

    assert setup.mode is EgressMode.FULL
    assert events == ["install", "drop"]
    default = inspect.signature(secure_startup).parameters["detect"].default
    assert default is None  # the production default is the kernel's own answer (select_egress_mode)
