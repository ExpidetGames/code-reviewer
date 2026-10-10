"""The real wiring of the job loop: logging, signals and the event loop."""

import asyncio
import logging
import os
import signal
import sys
from collections.abc import Mapping

from code_reviewer_runner.job_loop.api import HttpRunnerApi
from code_reviewer_runner.job_loop.loop import RunnerLoop
from code_reviewer_runner.job_loop.masking import SecretMasker
from code_reviewer_runner.job_loop.process import ProcessLauncher, SubprocessLauncher
from code_reviewer_runner.job_loop.settings import (
    LoopSettings,
    SettingsError,
    settings_from_environment,
)

LOGGER_NAME = "code_reviewer_runner.loop"


def configure_logging(stream: object = None) -> None:
    """Plain lines on stderr; stdout stays free."""
    handler = logging.StreamHandler(stream or sys.stderr)  # type: ignore[arg-type]
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger = logging.getLogger(LOGGER_NAME)
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False


async def serve(
    settings: LoopSettings,
    environment: Mapping[str, str],
    *,
    launcher: ProcessLauncher | None = None,
) -> int:
    """Run the loop until SIGTERM or SIGINT; a second signal ends the running jobs at once."""
    api = HttpRunnerApi(
        settings.api_url,
        settings.token,
        settings.runner_id,
        request_timeout=settings.request_timeout,
    )
    loop = RunnerLoop(
        settings,
        api,
        launcher or SubprocessLauncher(settings.terminate_grace),
        logger=logging.getLogger(LOGGER_NAME),
        environment=environment,
        masker=SecretMasker([settings.token]),
    )
    signals_seen = 0

    def on_signal() -> None:
        nonlocal signals_seen
        signals_seen += 1
        if signals_seen == 1:
            loop.request_stop()
        else:
            loop.request_force()

    running = asyncio.get_running_loop()
    for number in (signal.SIGTERM, signal.SIGINT):
        running.add_signal_handler(number, on_signal)
    try:
        await loop.run()
    finally:
        for number in (signal.SIGTERM, signal.SIGINT):
            running.remove_signal_handler(number)
    return 0


def run_from_environment(environment: Mapping[str, str] | None = None) -> int:
    """Entry of `code-reviewer-runner` without arguments. Returns the process exit code."""
    env = dict(os.environ if environment is None else environment)
    configure_logging()
    try:
        settings = settings_from_environment(env)
    except SettingsError as error:
        logging.getLogger(LOGGER_NAME).error("cannot start: %s", error)
        return 2
    return asyncio.run(serve(settings, env))
