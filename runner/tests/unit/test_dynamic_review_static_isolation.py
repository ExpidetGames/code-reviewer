# SPDX-License-Identifier: Apache-2.0

"""The one-time network setup of the Dynamic runner and the end of NET_ADMIN (#244), without root.

The syscalls themselves (the bounding-set drop, `capset`) and the effect on a real process are
proven as root by the privileged suite (`tests/privileged/startup`); here the order, the failure
behaviour and the reading of a capability status are pinned.
"""

import _thread
import logging
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review import static_isolation
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.static_isolation import (
    CAP_NET_ADMIN,
    CAP_SETPCAP,
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
    )

    assert installed is True
    assert events == ["install:10180:10181", "drop"]


# #244-T05
def test_rules_that_cannot_be_installed_still_end_net_admin_and_report_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    events: list[str] = []

    def refuse(proxy: int, engine: int) -> None:
        raise IsolationError("the network filter tool is not installed")

    with caplog.at_level(logging.ERROR, logger="code_reviewer_runner.loop"):
        installed = secure_startup(10101, PORTS, install=refuse, drop=lambda: events.append("drop"))

    # The runner keeps serving Diff jobs without the capability; Dynamic jobs fail their probe.
    assert installed is False
    assert events == ["drop"]
    assert ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED.value in caplog.text


# #244-T05
def test_a_drop_that_fails_is_never_swallowed() -> None:
    def cannot_drop() -> None:
        raise IsolationError("a capability could not be dropped from the bounding set")

    with pytest.raises(IsolationError) as caught:
        secure_startup(10101, PORTS, install=lambda proxy, engine: None, drop=cannot_drop)

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

    assert installed is False
    assert events == ["drop"]
    assert ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED.value in caplog.text


# #244-T05
def test_rules_that_cannot_be_installed_are_logged_once_at_error_level(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def refuse(proxy: int, engine: int) -> None:
        raise IsolationError("the network filter tool is not installed")

    def startup(uid: int, ports: SlotPorts) -> bool:
        return secure_startup(uid, ports, install=refuse, drop=lambda: None)

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

    def startup(uid: int, ports: SlotPorts) -> bool:
        calls.append((uid, ports))
        return True

    prepare_dynamic_runtime(settings(), startup=startup)  # a Diff-only runner
    assert calls == []

    prepare_dynamic_runtime(settings((10101, 10101), PORTS), startup=startup)
    assert calls == [(10101, PORTS)]


# #244-T05
def test_a_runner_whose_capabilities_cannot_be_dropped_does_not_start() -> None:
    def broken(uid: int, ports: SlotPorts) -> bool:
        raise IsolationError("a capability could not be dropped from the bounding set")

    with pytest.raises(IsolationError):
        prepare_dynamic_runtime(settings((10101, 10101), PORTS), startup=broken)
