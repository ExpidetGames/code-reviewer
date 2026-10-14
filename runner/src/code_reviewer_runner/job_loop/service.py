# SPDX-License-Identifier: Apache-2.0

"""The real wiring of the job loop: logging, signals and the event loop."""

import asyncio
import logging
import os
import signal
import sys
from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any

from code_reviewer_runner.capabilities import self_check_outcome
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.self_check import (
    DEFAULT_TOOLS,
    SelfCheckReason,
    check_dynamic_runner,
)
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts, secure_startup
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


def prepare_dynamic_runtime(
    settings: LoopSettings, *, startup: Callable[[int, SlotPorts], bool] = secure_startup
) -> bool:
    """The Dynamic runner's one-time network setup, before the loop and any thread exist (#244).

    Installs the engine user's static nft rules and drops `NET_ADMIN` for good. Returns False when
    the rules could not be installed (Dynamic jobs then fail closed; `secure_startup` logs why).
    Raises `IsolationError` when the capabilities could not be dropped: such a runner must not
    start. A runner without an engine user (Diff only) has nothing to do.
    """
    user, ports = settings.dynamic_engine_user, settings.dynamic_ports
    if user is None or ports is None:
        return True
    return startup(user[0], ports)


def advertise_engines(
    settings: LoopSettings,
    rules_installed: bool,
    *,
    check: Callable[..., None] | None = None,
) -> LoopSettings:
    """The settings with the engines this runner may advertise, decided by the startup self-check.

    `opencode` is added (with the verified engine command the Dynamic job process is handed) only
    when `check_dynamic_runner` passes: root supervisor, engine user, static rules installed,
    startup capabilities dropped, pinned and trusted engine and `rg`, probe as the engine user. Any
    failure leaves `pr-agent` only and logs the stable reason, never a value. A runner without an
    engine user (every runner but the Dynamic one) is not a failure: it serves Diff jobs, as
    designed.
    """
    run_check = check or check_dynamic_runner
    engines, error = self_check_outcome(
        lambda: run_check(
            user=settings.dynamic_engine_user,
            ports=settings.dynamic_ports,
            rules_installed=rules_installed,
        )
    )
    log = logging.getLogger(LOGGER_NAME)
    if error is None:
        log.info("Dynamic Review: opencode is advertised, the startup self-check passed")
        return replace(settings, engines=engines, dynamic_command=(str(DEFAULT_TOOLS.opencode),))
    reason: Any = getattr(error, "reason", None)
    named = reason.value if isinstance(reason, SelfCheckReason) else "self_check_error"
    if settings.dynamic_engine_user is None:
        log.info("Dynamic Review: this runner serves Diff jobs only (%s)", named)
    else:
        log.warning(
            "Dynamic Review: opencode is not advertised, this runner serves Diff jobs only "
            "(%s: %s)",
            error.code.value,
            named,
        )
    return replace(settings, engines=engines, dynamic_command=None)


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
        engines=settings.engines,
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
    try:
        rules_installed = prepare_dynamic_runtime(settings)
    except IsolationError as error:
        logging.getLogger(LOGGER_NAME).error("cannot start: %s", error)
        return 2
    # After the network setup and the end of NET_ADMIN, before the first claim: `opencode` is only
    # ever in a claim after the self-check passed.
    return asyncio.run(serve(advertise_engines(settings, rules_installed), env))
