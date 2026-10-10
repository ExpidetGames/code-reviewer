"""Pins down the small parts of the job loop: output buffers, log masking and back-off."""

import logging

import pytest

from code_reviewer_runner.job_loop.loop import Backoff
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


def test_the_backoff_doubles_up_to_its_maximum_and_starts_over_after_a_reset() -> None:
    backoff = Backoff(base=5, maximum=40)

    assert [backoff.next() for _ in range(5)] == [5, 10, 20, 40, 40]
    backoff.reset()
    assert backoff.next() == 5


def test_a_retry_after_longer_than_the_backoff_wins_but_is_capped() -> None:
    backoff = Backoff(base=5, maximum=40)

    assert backoff.next(retry_after=100) == 100
    assert backoff.next(retry_after=10_000) == 15 * 60
