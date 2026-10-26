# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the small parts of the job host: output buffers and log masking."""

import logging
from typing import Any

import pytest

from code_reviewer_runner.job_loop.masking import SafeLog, SecretMasker
from code_reviewer_runner.job_loop.process import StreamTail


# CR-29-T18
def test_a_stream_tail_keeps_only_the_newest_bytes_and_never_grows_beyond_twice_that() -> None:
    tail = StreamTail(keep=1000)

    for number in range(10_000):
        tail.add(f"{number:08d}\n".encode())

    everything = b"".join(f"{n:08d}\n".encode() for n in range(10_000))
    assert tail.value() == everything[-1000:]
    assert tail.peak <= 2 * 1000 + 9
    assert tail.total == 90_000
    assert tail.truncated is True


def test_a_stream_tail_that_never_filled_up_is_not_truncated() -> None:
    tail = StreamTail(keep=1000)
    tail.add(b"short")

    assert tail.value() == b"short" and tail.truncated is False


def test_the_masker_hides_the_secrets_of_running_jobs_until_the_job_is_gone() -> None:
    masker = SecretMasker(["runner-token-0123456789"])
    masker.add("job-1", ["job-secret-abcdefghij"])

    text = "runner-token-0123456789 and job-secret-abcdefghij"
    assert masker.redact(text) == "[REDACTED] and [REDACTED]"
    masker.discard("job-1")
    assert masker.redact(text) == "[REDACTED] and job-secret-abcdefghij"


def test_the_safe_log_masks_after_formatting(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="safe-log-test")
    log = SafeLog(logging.getLogger("safe-log-test"), SecretMasker(["abcdef-secret-ghijkl"]))

    log.info("value %s", "abcdef-secret-ghijkl")
    log.warning("plain")

    assert caplog.messages == ["value [REDACTED]", "plain"]


# #197-T04
def test_a_process_with_a_user_is_started_as_that_user_with_no_other_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    from code_reviewer_runner.job_loop import process as process_module
    from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher

    seen: dict[str, Any] = {}
    chowned: list[tuple[str, int, int]] = []

    class Stop(Exception):
        pass

    def fake_popen(*argv: Any, **options: Any) -> Any:
        seen.update(options)
        raise Stop

    monkeypatch.setattr(process_module.subprocess, "Popen", fake_popen)

    def record_chown(path: Any, uid: int, gid: int) -> None:
        chowned.append((str(path), uid, gid))

    monkeypatch.setattr(process_module.os, "chown", record_chown)

    spec = ProcessSpec(argv=("job",), env={}, stdin=b"", run_as=(10001, 10002))
    with pytest.raises(Stop):
        asyncio.run(SubprocessLauncher().start(spec))

    assert (seen["user"], seen["group"], seen["extra_groups"]) == (10001, 10002, [])
    assert [(uid, gid) for _, uid, gid in chowned] == [(10001, 10002)]  # its working directory
    assert seen["start_new_session"] is True
