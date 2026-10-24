# SPDX-License-Identifier: LicenseRef-Proprietary

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
from code_reviewer_runner.dynamic_review.netguard import EgressMode, IsolationError
from code_reviewer_runner.dynamic_review.self_check import (
    DEFAULT_TOOLS,
    SelfCheckReason,
    SelfCheckResult,
    check_dynamic_runner,
    root_filesystem_read_only,
)
from code_reviewer_runner.dynamic_review.static_isolation import (
    EgressSetup,
    SlotPorts,
    secure_startup,
)
from code_reviewer_runner.engines_file import remove_engines_file, write_engines_file
from code_reviewer_runner.job_loop.api import HttpRunnerApi
from code_reviewer_runner.job_loop.loop import RunnerLoop
from code_reviewer_runner.job_loop.masking import SecretMasker
from code_reviewer_runner.job_loop.process import ProcessLauncher, SubprocessLauncher
from code_reviewer_runner.job_loop.settings import (
    LoopSettings,
    SettingsError,
    WorkerSettings,
    settings_from_environment,
)
from code_reviewer_runner.verdict import Verdict

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
    settings: LoopSettings | WorkerSettings,
    *,
    startup: Callable[[int, SlotPorts], EgressSetup] = secure_startup,
) -> EgressSetup:
    """The Dynamic runner's one-time network setup, before the loop and any thread exist (#244).

    Installs the engine user's static nft rules (the full or the fallback ruleset, whichever the
    kernel supports, #345) and drops `NET_ADMIN` for good. `rules_installed` is False when the
    rules could not be installed (Dynamic jobs then fail closed; `secure_startup` logs why).
    Raises `IsolationError` when the capabilities could not be dropped: such a runner must not
    start. A runner without an engine user (Diff only) has nothing to do.
    """
    user, ports = settings.dynamic_engine_user, settings.dynamic_ports
    if user is None or ports is None:
        return EgressSetup(True, EgressMode.FULL)
    return startup(user[0], ports)


def decide_engines[Settings: (LoopSettings, WorkerSettings)](
    settings: Settings,
    rules_installed: bool,
    *,
    egress_mode: EgressMode = EgressMode.FULL,
    check: Callable[..., object] | None = None,
    require_read_only_root: bool = False,
) -> tuple[Settings, str | None]:
    """The settings with the engines this runner may advertise, decided by the startup self-check,
    and the stable reason `opencode` is missing (None when it is advertised).

    `opencode` is added (with the verified engine command the Dynamic job process is handed) only
    when `check_dynamic_runner` passes: root supervisor, engine user, static rules installed,
    startup capabilities dropped, pinned and trusted engine and `rg`, probe as the engine user (and,
    with the fallback ruleset, IPv6 proven off). Any failure leaves `pr-agent` only and logs the
    stable reason, never a value. The egress mode startup found is logged and kept in the settings
    for the job processes (#345). A runner without an engine user (every runner but the Dynamic
    one) is not a failure: it serves Diff jobs, as designed. `require_read_only_root` is for the
    entry modes of the Worker image (#324): the check then also needs the read-only root of the
    hardened container spec.
    """
    run_check = check or check_dynamic_runner
    passed: list[EgressMode] = []
    # Only a mode that asks for it passes the extra fact: the checks of the other modes (and their
    # doubles) are called exactly as before.
    extra: dict[str, Any] = (
        {"root_read_only": root_filesystem_read_only} if require_read_only_root else {}
    )

    def verify() -> None:
        result = run_check(
            user=settings.dynamic_engine_user,
            ports=settings.dynamic_ports,
            rules_installed=rules_installed,
            egress_mode=egress_mode,
            **extra,
        )
        passed.append(result.egress_mode if isinstance(result, SelfCheckResult) else egress_mode)

    engines, error = self_check_outcome(verify)
    log = logging.getLogger(LOGGER_NAME)
    if error is None:
        mode = passed[0]
        log.info(
            "Dynamic Review: opencode is advertised, the startup self-check passed "
            "(egress rules: %s)",
            mode.value,
        )
        return (
            replace(
                settings,
                engines=engines,
                dynamic_command=(str(DEFAULT_TOOLS.opencode),),
                dynamic_ripgrep=str(DEFAULT_TOOLS.ripgrep),
                dynamic_egress_mode=mode,
            ),
            None,
        )
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
    return (
        replace(
            settings,
            engines=engines,
            dynamic_command=None,
            dynamic_ripgrep=None,
            dynamic_egress_mode=egress_mode,
        ),
        named,
    )


def advertise_engines[Settings: (LoopSettings, WorkerSettings)](
    settings: Settings,
    rules_installed: bool,
    *,
    egress_mode: EgressMode = EgressMode.FULL,
    check: Callable[..., object] | None = None,
    require_read_only_root: bool = False,
) -> Settings:
    """`decide_engines` without the reason: the settings with the engines to advertise."""
    return decide_engines(
        settings,
        rules_installed,
        egress_mode=egress_mode,
        check=check,
        require_read_only_root=require_read_only_root,
    )[0]


def run_startup[Settings: (LoopSettings, WorkerSettings)](
    settings: Settings,
    *,
    require_read_only_root: bool = False,
    remove_verdict: Callable[[], object] | None = None,
    write_verdict: Callable[[Verdict], object] | None = None,
) -> tuple[Settings, Verdict]:
    """The startup every entry mode runs once at container start (#324).

    The verdict of an earlier start is removed first. Then the network setup and the end of
    `NET_ADMIN` (`prepare_dynamic_runtime`; `IsolationError` when the capabilities could not be
    dropped: nothing may start then), then the engines to advertise (`decide_engines`), and last
    the verdict is written to the engines file. All of it before the event loop, any thread and
    any job process exist.
    """
    (remove_verdict or remove_engines_file)()
    setup = prepare_dynamic_runtime(settings)
    decided, reason = decide_engines(
        settings,
        setup.rules_installed,
        egress_mode=setup.mode,
        require_read_only_root=require_read_only_root,
    )
    verdict = Verdict(decided.engines, (reason,) if reason else ())
    (write_verdict or write_engines_file)(verdict)
    return decided, verdict


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
        # After the network setup and the end of NET_ADMIN, before the first claim: `opencode` is
        # only ever in a claim after the self-check passed.
        settings, _ = run_startup(settings)
    except IsolationError as error:
        logging.getLogger(LOGGER_NAME).error("cannot start: %s", error)
        return 2
    return asyncio.run(serve(settings, env))
