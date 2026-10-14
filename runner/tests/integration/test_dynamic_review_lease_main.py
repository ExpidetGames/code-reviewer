# SPDX-License-Identifier: Apache-2.0

"""The lease check as the real entry point wires it (#260).

`run_dynamic_job` takes the check as a seam, and the loop's side is tested on its own. What joins
them is `runner.main`: the variable the loop sets turns into the check there and nowhere else. These
tests drive `main` itself, so a refactor that drops the wiring leaves a Dynamic run publishing with
no check at all and is caught here. The summary writer and the preparation are replaced by the same
recorders the other Dynamic job tests use; nothing is a real model or network call.
"""

import io
import json
import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from test_dynamic_review_job import (
    Preparer,
    RecordingPublisher,
    environment,
    fake_engine_needs_no_ripgrep,
    job_document,
    reading_upstream,
    structured_script,
)

from code_reviewer_runner import runner
from code_reviewer_runner.lease_check import LEASE_CHECK_FD_VARIABLE
from code_reviewer_runner.result import ErrorCode

pytestmark = pytest.mark.usefixtures(fake_engine_needs_no_ripgrep.__name__)


@pytest.fixture
def ends() -> Iterator[tuple[socket.socket, socket.socket]]:
    """(the process's end, the loop's end) of a channel."""
    process_end, loop_end = socket.socketpair()
    yield process_end, loop_end
    loop_end.close()
    process_end.close()


def run_main(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, descriptor: str | None
) -> tuple[dict[str, Any], int, RecordingPublisher]:
    """Run a Dynamic job through `main`; `descriptor` is what the loop would have put in the
    environment (None: nothing)."""
    preparer = Preparer(tmp_path / "export", structured_script())
    publisher = RecordingPublisher(preparer)

    def prepared(*args: Any, **kwargs: Any) -> Preparer:
        return preparer

    monkeypatch.setattr(runner, "production_preparer", prepared)
    monkeypatch.setattr(runner, "publish_run", publisher)
    monkeypatch.setenv("RUNNER_ADVERTISED_ENGINES", "pr-agent,opencode")
    for name, value in environment().items():
        monkeypatch.setenv(name, value)
    if descriptor is None:
        monkeypatch.delenv(LEASE_CHECK_FD_VARIABLE, raising=False)
    else:
        monkeypatch.setenv(LEASE_CHECK_FD_VARIABLE, descriptor)
    out = io.StringIO()
    with reading_upstream() as upstream:
        document = job_document(f"{upstream.url}/v1")
        code = runner.main([], stdin=io.StringIO(json.dumps(document)), stdout=out)
    return json.loads(out.getvalue()), code, publisher


# #260-T01
def test_the_entry_point_asks_over_the_descriptor_it_was_given_and_a_lost_job_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, ends: tuple[socket.socket, socket.socket]
) -> None:
    process_end, loop_end = ends
    loop_end.sendall(b"lost\n")

    result, code, publisher = run_main(monkeypatch, tmp_path, str(process_end.detach()))

    assert code == 1
    assert result["errorCode"] == ErrorCode.LEASE_LOST.value
    assert result["commentUrl"] is None
    assert publisher.calls == []
    # It really asked: the question is on the channel.
    assert loop_end.recv(16) == b"check\n"


# #260-T03
def test_the_entry_point_publishes_as_before_for_a_job_that_is_held(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, ends: tuple[socket.socket, socket.socket]
) -> None:
    process_end, loop_end = ends
    loop_end.sendall(b"held\n")

    result, code, publisher = run_main(monkeypatch, tmp_path, str(process_end.detach()))

    assert code == 0, result
    assert result["commentUrl"] == RecordingPublisher.URL
    assert len(publisher.calls) == 1


# #260-T01
@pytest.mark.parametrize("descriptor", ["999999", "-1", "not-a-descriptor", ""])
def test_a_descriptor_that_is_named_but_unusable_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, descriptor: str
) -> None:
    result, code, publisher = run_main(monkeypatch, tmp_path, descriptor)

    assert code == 1
    assert result["errorCode"] == ErrorCode.LEASE_LOST.value
    assert publisher.calls == []


# #260-T01: a Dynamic job is only ever run by the loop, which always hands the descriptor over; a
# wrapper that scrubs it is no reason to write unchecked.
def test_a_dynamic_job_without_the_descriptor_writes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    result, code, publisher = run_main(monkeypatch, tmp_path, None)

    assert code == 1
    assert result["errorCode"] == ErrorCode.LEASE_LOST.value
    assert publisher.calls == []
