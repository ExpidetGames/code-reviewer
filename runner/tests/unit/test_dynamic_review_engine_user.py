# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the supervisor starts the engine as the dedicated user (#197), as far as it needs no root.

The setuid itself, the network rules and the kill of a user's leftover processes are proven as root
by the privileged suite (`tests/privileged`).
"""

import contextlib
import json
import os
import stat
from collections.abc import Callable
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review import engine_user
from code_reviewer_runner.dynamic_review.engine_user import (
    EngineLaunch,
    listener_uids,
    user_pids,
)
from code_reviewer_runner.dynamic_review.netguard import EgressMode, IsolationError
from code_reviewer_runner.result import ErrorCode

HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid"


def record_probe(probed: list[int]) -> Callable[[int, int, int], None]:
    """A stand-in for `verify_confinement` that notes the port it was asked to prove."""

    def probe(uid: int, gid: int, port: int) -> None:
        probed.append(port)

    return probe


def event_probe(events: list[str]) -> Callable[[int, int, int], None]:
    """A stand-in for `verify_confinement` that notes in `events` which port it was asked for."""

    def probe(uid: int, gid: int, port: int) -> None:
        events.append(f"probe:{port}")

    return probe


def row(local: str, state: str, uid: int, remote: str = "00000000:0000") -> str:
    return f"   0: {local} {remote} {state} 00000000:00000000 00:00000000 00000000 {uid} 0 1 1"


TCP = "\n".join(
    [
        HEADER,
        row("0100007F:A0B8", "0A", 10101),
        row("0100007F:A0B9", "0A", 0),
        row("0100007F:A0B8", "01", 0, remote="0100007F:C350"),
    ]
)
TCP6 = "\n".join([HEADER, row("00000000000000000000000001000000:A0BA", "0A", 1002)])


def launch(tmp_path: Path, uid: int | None = None, gid: int | None = None) -> EngineLaunch:
    config_dir = tmp_path / "job"
    config_dir.mkdir()
    return EngineLaunch(
        config_owner=os.getuid(),  # root in production; a test cannot give a file to root
        uid=os.getuid() if uid is None else uid,
        gid=os.getgid() if gid is None else gid,
        home=str(tmp_path / "home"),
        tmpdir=str(tmp_path / "tmp"),
        config_dir=config_dir,
    )


# #197-T04
def test_the_listener_of_a_port_is_read_from_the_kernel_tables() -> None:
    assert listener_uids(0xA0B8, {"tcp": TCP}) == {10101}  # the established row is not a listener
    assert listener_uids(0xA0B9, {"tcp": TCP}) == {0}
    assert listener_uids(0xA0BA, {"tcp": TCP, "tcp6": TCP6}) == {1002}
    assert listener_uids(0x1234, {"tcp": TCP, "tcp6": TCP6}) == set()


# #197-T04
def test_a_port_is_the_engines_only_when_nobody_else_listens_on_it(tmp_path: Path) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)

    assert mine.owns_listener(0xA0B8, tables={"tcp": TCP})
    assert not mine.owns_listener(0xA0B9, tables={"tcp": TCP})  # a stranger's
    assert not mine.owns_listener(0x1234, tables={"tcp": TCP})  # nobody's: not proven
    both = "\n".join([TCP, row("0100007F:A0B8", "0A", 1002)])
    assert not mine.owns_listener(0xA0B8, tables={"tcp": both})  # shared with a stranger


# #197-T04
def test_a_process_is_started_as_the_dedicated_user_with_no_other_group(tmp_path: Path) -> None:
    options = launch(tmp_path, uid=10101, gid=10102).spawn_options()

    assert options == {"user": 10101, "group": 10102, "extra_groups": []}


# #197-T04
def test_the_config_is_written_for_its_user_only(tmp_path: Path) -> None:
    mine = launch(tmp_path)

    path = mine.write_config({"capability": "dummy-capability"})

    assert path == tmp_path / "job" / "opencode.json"
    # Read-only for the engine's group, owned by someone else: the engine can neither rewrite the
    # file nor change its mode (the owner of the file is the supervisor, root in production).
    assert stat.S_IMODE(path.stat().st_mode) == 0o440
    assert (path.stat().st_uid, path.stat().st_gid) == (mine.config_owner, mine.gid)
    assert json.loads(path.read_text()) == {"capability": "dummy-capability"}


# #197-T04
def test_a_planted_link_in_place_of_the_config_is_not_followed(tmp_path: Path) -> None:
    mine = launch(tmp_path)
    target = tmp_path / "target"
    target.write_text("keep")
    (tmp_path / "job" / "opencode.json").symlink_to(target)

    with contextlib.suppress(OSError):
        mine.write_config({"capability": "x"})

    assert target.read_text() == "keep"


# #197-T07
def test_the_processes_of_a_user_are_listed_without_zombies() -> None:
    assert os.getpid() in user_pids(os.getuid())
    assert user_pids(2**31 - 5) == []


# #197-T07 #244-T02
def test_the_network_rules_are_static_and_closing_a_launch_never_touches_them(
    tmp_path: Path,
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    swept: list[bool] = []
    mine.sweep = lambda: swept.append(True) or True  # type: ignore[method-assign]

    # Whatever the sweep says, close() ends processes only; there is no nft call to make (the
    # supervisor holds no NET_ADMIN) and no attribute that could make one.
    assert mine.close() is True
    mine.sweep = lambda: False  # type: ignore[method-assign]  # a process stuck in D state
    assert mine.close() is False
    assert swept == [True]
    assert not hasattr(mine, "confinement")


# #197-T07 #244-T03
def test_no_job_starts_while_a_predecessors_process_survives_the_first_sweep(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    probed: list[int] = []
    monkeypatch.setattr(engine_user, "verify_confinement", record_probe(probed))
    mine.sweep = lambda: False  # type: ignore[method-assign]

    with pytest.raises(IsolationError) as caught:
        mine.confine(mine.proxy_port, mine.engine_port)

    assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert probed == []  # no proof was taken and no engine can follow


# #244-T03
def test_a_job_proves_the_static_rules_once_after_checking_its_own_capabilities(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    events: list[str] = []
    mine.sweep = lambda: events.append("sweep") or True  # type: ignore[method-assign]
    monkeypatch.setattr(
        engine_user, "require_startup_capabilities_gone", lambda: events.append("capabilities")
    )
    monkeypatch.setattr(engine_user, "verify_confinement", event_probe(events))

    mine.confine(mine.proxy_port, mine.engine_port)
    mine.confine(mine.proxy_port, mine.engine_port)  # a start retry: nothing is proven twice

    assert events == [
        "sweep",
        "capabilities",
        f"probe:{mine.proxy_port}",
        "capabilities",
    ]


# #244-T03
def test_a_supervisor_that_still_holds_net_admin_means_no_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    probed: list[int] = []
    monkeypatch.setattr(engine_user, "verify_confinement", record_probe(probed))
    monkeypatch.setattr(
        engine_user,
        "require_startup_capabilities_gone",
        lambda: (_ for _ in ()).throw(IsolationError("the supervisor still holds a capability")),
    )
    mine.sweep = lambda: True  # type: ignore[method-assign]

    with pytest.raises(IsolationError):
        mine.confine(mine.proxy_port, mine.engine_port)

    assert probed == []


# #244-T03
@pytest.mark.parametrize("ports", [(1, 10181), (10180, 2), (10181, 10180)])
def test_ports_other_than_the_ones_the_static_rules_allow_are_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ports: tuple[int, int]
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    monkeypatch.setattr(engine_user, "verify_confinement", event_probe([]))
    monkeypatch.setattr(engine_user, "require_startup_capabilities_gone", lambda: None)
    mine.sweep = lambda: True  # type: ignore[method-assign]

    with pytest.raises(IsolationError):
        mine.confine(*ports)


# #197-T07
def test_a_missing_interpreter_is_a_failed_sweep(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_interpreter(command: str, path: str | None = None) -> None:
        return None

    monkeypatch.setattr(engine_user.shutil, "which", no_interpreter)

    assert launch(tmp_path).sweep() is False


# #345-T13
def test_in_fallback_mode_a_job_proves_ipv6_off_after_the_probe_and_only_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    mine.egress_mode = EgressMode.FALLBACK
    events: list[str] = []
    mine.sweep = lambda: True  # type: ignore[method-assign]
    monkeypatch.setattr(engine_user, "require_startup_capabilities_gone", lambda: None)
    monkeypatch.setattr(engine_user, "verify_confinement", event_probe(events))

    def record_ipv6(uid: int, gid: int) -> None:
        events.append(f"ipv6:{uid}:{gid}")

    monkeypatch.setattr(engine_user, "verify_ipv6_off", record_ipv6)

    mine.confine(mine.proxy_port, mine.engine_port)
    mine.confine(mine.proxy_port, mine.engine_port)

    assert events == [f"probe:{mine.proxy_port}", "ipv6:10101:10101"]


# #345-T13
def test_in_fallback_mode_ipv6_that_is_on_stops_the_job_before_the_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    mine.egress_mode = EgressMode.FALLBACK
    mine.sweep = lambda: True  # type: ignore[method-assign]
    monkeypatch.setattr(engine_user, "require_startup_capabilities_gone", lambda: None)
    monkeypatch.setattr(engine_user, "verify_confinement", event_probe([]))

    def ipv6_on(uid: int, gid: int) -> None:
        raise IsolationError("IPv6 is not switched off on every interface")

    monkeypatch.setattr(engine_user, "verify_ipv6_off", ipv6_on)

    with pytest.raises(IsolationError) as caught:
        mine.confine(mine.proxy_port, mine.engine_port)

    assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    # Not marked proven: the next attempt proves it again instead of trusting the failure.
    assert mine._verified is False  # pyright: ignore[reportPrivateUsage]


# #345-T13
def test_in_full_mode_no_ipv6_proof_runs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    assert mine.egress_mode is EgressMode.FULL
    events: list[str] = []
    mine.sweep = lambda: True  # type: ignore[method-assign]
    monkeypatch.setattr(engine_user, "require_startup_capabilities_gone", lambda: None)
    monkeypatch.setattr(engine_user, "verify_confinement", event_probe(events))

    def must_not_run(uid: int, gid: int) -> None:
        events.append("ipv6-must-not-run")

    monkeypatch.setattr(engine_user, "verify_ipv6_off", must_not_run)

    mine.confine(mine.proxy_port, mine.engine_port)

    assert events == [f"probe:{mine.proxy_port}"]
