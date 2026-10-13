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

from code_reviewer_runner.dynamic_review.engine_user import (
    EngineLaunch,
    listener_uids,
    user_pids,
)

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
    assert stat.S_IMODE(path.stat().st_mode) == 0o400
    assert path.stat().st_uid == mine.uid
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
