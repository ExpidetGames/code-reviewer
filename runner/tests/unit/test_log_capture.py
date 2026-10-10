"""Pins down the log capture: PR-Agent logs through loguru, the runner owns the only sink, keeps
a short redacted tail for the result and collects the exceptions that error records carry."""

import logging

import pytest
from loguru import logger

from code_reviewer_runner.log_capture import LogCapture, StdlibLogHandler
from code_reviewer_runner.redaction import REDACTED, Redactor

TOKEN = "dummy-installation-token-0123456789"


@pytest.fixture
def capture() -> LogCapture:
    return LogCapture(Redactor([TOKEN]))


@pytest.fixture(autouse=True)
def clean_loguru() -> None:
    logger.remove()


def attach(capture: LogCapture, level: str = "INFO") -> int:
    return logger.add(capture, level=level, format="{message}")


# CR-10-T07
def test_a_secret_in_a_log_message_is_redacted_in_the_tail(capture: LogCapture) -> None:
    attach(capture)

    logger.info(f"calling with {TOKEN}")

    assert TOKEN not in capture.tail()
    assert REDACTED in capture.tail()


def test_a_secret_in_an_exception_text_is_redacted_in_the_tail(capture: LogCapture) -> None:
    attach(capture)

    try:
        raise RuntimeError(f"upstream rejected {TOKEN}")
    except RuntimeError:
        logger.exception("Failed to process the command.")

    tail = capture.tail()
    assert TOKEN not in tail
    assert "RuntimeError" in tail
    assert "Traceback" not in tail


def test_debug_records_are_not_captured_at_the_info_level(capture: LogCapture) -> None:
    attach(capture, level="INFO")

    logger.debug("the whole diff and prompt would be here")
    logger.info("Reviewing PR")

    assert "diff" not in capture.tail()
    assert "Reviewing PR" in capture.tail()


def test_analytics_records_are_ignored(capture: LogCapture) -> None:
    attach(capture)

    logger.bind(analytics=True).info("telemetry blob")

    assert capture.tail() == ""


def test_the_harmless_missing_settings_file_warning_is_dropped(capture: LogCapture) -> None:
    attach(capture)

    logger.warning("Settings file not found: /x/.secrets.toml. Skipping it.")
    logger.warning("something else")

    assert "Settings file" not in capture.tail()
    assert "something else" in capture.tail()


def test_exceptions_of_error_records_are_collected_for_classification(
    capture: LogCapture,
) -> None:
    attach(capture)

    try:
        raise ValueError("boom")
    except ValueError:
        logger.exception("Failed to process the command.")
    logger.info("not an error")

    assert [str(error) for error in capture.exceptions] == ["boom"]
    assert capture.error_messages == ["Failed to process the command."]


# CR-10-T07
def test_the_tail_is_limited_to_four_kilobytes_and_keeps_the_newest_lines(
    capture: LogCapture,
) -> None:
    attach(capture)

    for number in range(500):
        logger.info(f"line {number:04d} " + "x" * 60)

    tail = capture.tail()
    assert len(tail.encode("utf-8")) <= 4096
    assert "line 0499" in tail
    assert "line 0000" not in tail


def test_warnings_and_errors_survive_a_flood_of_info_lines(capture: LogCapture) -> None:
    attach(capture)
    logger.error("the real problem")

    for number in range(500):
        logger.info(f"line {number:04d} " + "x" * 60)

    assert "the real problem" in capture.tail()
    assert len(capture.tail().encode("utf-8")) <= 4096


def test_the_tail_is_cut_on_a_character_boundary() -> None:
    capture = LogCapture(Redactor([]), max_tail_bytes=64)
    logger.add(capture, level="INFO", format="{message}")

    logger.info("é" * 100)

    assert len(capture.tail().encode("utf-8")) <= 64
    capture.tail().encode("utf-8").decode("utf-8")


def test_standard_library_loggers_end_up_in_the_tail_when_they_warn(capture: LogCapture) -> None:
    handler = StdlibLogHandler(capture)
    stdlib_logger = logging.getLogger("code_reviewer_runner.test")
    stdlib_logger.addHandler(handler)
    stdlib_logger.setLevel(logging.INFO)
    try:
        stdlib_logger.warning(f"urllib3 says {TOKEN}")
        stdlib_logger.info("quiet")
    finally:
        stdlib_logger.removeHandler(handler)

    assert "urllib3 says" in capture.tail()
    assert TOKEN not in capture.tail()
    assert "quiet" not in capture.tail()


def test_the_exception_of_the_final_failure_record_comes_before_earlier_benign_errors(
    capture: LogCapture,
) -> None:
    attach(capture)
    try:
        raise KeyError("benign: no AGENTS.md")
    except KeyError:
        logger.exception("Failed to fetch repo context file")
    try:
        raise ValueError("the real one")
    except ValueError:
        logger.exception("Failed to process the command.")
    try:
        raise OSError("late noise")
    except OSError:
        logger.exception("Failed to flush telemetry")

    assert str(capture.exceptions[0]) == "the real one"
    assert len(capture.exceptions) == 3


def test_the_final_failure_survives_a_flood_of_earlier_errors(capture: LogCapture) -> None:
    attach(capture)
    for number in range(100):
        try:
            raise KeyError(f"noise {number}")
        except KeyError:
            logger.exception("Failed to fetch repo context file")
    try:
        raise ValueError("the real one")
    except ValueError:
        logger.exception("Failed to process the command.")

    assert str(capture.exceptions[0]) == "the real one"
