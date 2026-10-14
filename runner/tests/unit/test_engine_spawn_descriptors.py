# SPDX-License-Identifier: Apache-2.0

"""The engine child inherits no descriptor of the supervisor (#260).

The lease descriptor is non-inheritable in the supervisor, and the engine is started with the
default `close_fds=True` and no `pass_fds`. This pins the second layer: the engine is the process
that runs a model's tool calls, and it must never hold the channel to the loop.
"""

from pathlib import Path
from typing import Any

import pytest
from test_dynamic_review_ripgrep_path import engine_with, executable

from code_reviewer_runner.dynamic_review.adapter import EngineError


# #260-T01
def test_the_engine_is_started_with_every_other_descriptor_closed(tmp_path: Path) -> None:
    ripgrep = executable(tmp_path / "verified" / "rg")
    spawned: list[dict[str, Any]] = []
    engine = engine_with(tmp_path, ripgrep=ripgrep, node_bin=None, seen=[])

    def popen(argv: list[str], **kwargs: Any) -> Any:
        spawned.append(kwargs)
        raise OSError("no process in this test")

    engine._popen = popen  # type: ignore[assignment]  # pyright: ignore[reportPrivateUsage]
    with pytest.raises(EngineError):
        engine.start()

    assert len(spawned) == 1
    assert spawned[0].get("close_fds", True) is True
    assert not spawned[0].get("pass_fds")
