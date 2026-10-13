# SPDX-License-Identifier: Apache-2.0

"""How the supervisor starts the engine as the dedicated user (#197), as far as it needs no root.

The setuid itself, the network rules and the kill of a user's leftover processes are proven as root
by the privileged suite (`tests/privileged`).
"""

import contextlib
import json
import os
import stat
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review import engine_user
from code_reviewer_runner.dynamic_review.engine_user import (
    EngineLaunch,
    listener_uids,
    user_pids,
)
from code_reviewer_runner.dynamic_review.netguard import IsolationError, table_name
from code_reviewer_runner.result import ErrorCode

HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid"


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


def recorded(mine: EngineLaunch) -> list[str]:
    """Replace the nft call of `mine` by a list of the scripts it was asked to run."""
    scripts: list[str] = []
    mine.confinement.run = scripts.append
    return scripts


# #197-T07
def test_the_network_rules_stay_when_the_sweep_cannot_finish(tmp_path: Path) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    scripts = recorded(mine)
    mine.confinement.apply(4000, 4001)
    mine.sweep = lambda: False  # type: ignore[method-assign]  # a process stuck in D state

    swept = mine.close()

    # Deleting the table now would leave a survivor of that user without any boundary.
    assert swept is False
    assert len(scripts) == 1
    assert f"delete table inet {table_name(10101)}" not in "".join(scripts)


# #197-T07
def test_the_network_rules_go_once_the_sweep_has_finished(tmp_path: Path) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    scripts = recorded(mine)
    mine.confinement.apply(4000, 4001)
    mine.sweep = lambda: True  # type: ignore[method-assign]

    assert mine.close() is True
    assert scripts[-1] == f"delete table inet {table_name(10101)}\n"


# #197-T07
def test_no_job_starts_while_a_predecessors_process_survives_the_first_sweep(
    tmp_path: Path,
) -> None:
    mine = launch(tmp_path, uid=10101, gid=10101)
    scripts = recorded(mine)
    mine.sweep = lambda: False  # type: ignore[method-assign]

    with pytest.raises(IsolationError) as caught:
        mine.confine(4000, 4001)

    assert caught.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert scripts == []  # nothing was installed and no engine can follow


# #197-T07
def test_a_missing_interpreter_is_a_failed_sweep(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_interpreter(command: str, path: str | None = None) -> None:
        return None

    monkeypatch.setattr(engine_user.shutil, "which", no_interpreter)

    assert launch(tmp_path).sweep() is False
