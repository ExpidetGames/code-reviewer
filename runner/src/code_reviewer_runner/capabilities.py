# SPDX-License-Identifier: Apache-2.0

"""The engines a runner may advertise, and the startup self-check that gates them (#195).

A runner advertises an engine in the claim body only after the startup self-check proved the
isolation is effective. The check is simple and fails closed: the engine process must run as the
dedicated unprivileged user, the export mechanism must be read-only for it, and egress must be
proxy-only. A failure never falls back to a host setting, a fork or a weaker mode: the engine is
simply not advertised, and the job loop logs the stable isolation code.

The concrete probes against the container belong to #202; this module owns the policy and the
result. The configured check is deliberately fail-closed until #202 supplies the probes, so this
stage never advertises `opencode`.
"""

from collections.abc import Callable
from dataclasses import dataclass

from code_reviewer_runner.result import ErrorCode

ENGINE_DIFF = "pr-agent"
ENGINE_DYNAMIC = "opencode"
ALL_ENGINES: tuple[str, ...] = (ENGINE_DIFF, ENGINE_DYNAMIC)


class IsolationSelfCheckError(Exception):
    """The startup self-check failed.

    `code` is stable; `detail` names the property, never a value.
    """

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class IsolationFacts:
    """The effective facts the self-check reads. #202 measures them; here they are injected."""

    # The user the engine process would run as, and the dedicated unprivileged user it must be.
    uid: int
    expected_uid: int
    # True when the prepared export is read-only for the engine user.
    export_read_only: bool
    # True when the only network the engine can reach is the runner-owned model proxy.
    egress_proxy_only: bool


def verify_isolation(facts: IsolationFacts) -> None:
    """Raise `IsolationSelfCheckError` unless every isolation property holds. Fail closed."""
    if facts.uid == 0:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the engine would run as root, not the dedicated unprivileged user",
        )
    if facts.uid != facts.expected_uid:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the engine user is not the dedicated unprivileged user",
        )
    if not facts.export_read_only:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the prepared export is writable by the engine user",
        )
    if not facts.egress_proxy_only:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "egress is not proxy-only",
        )


def advertised_engines(verify: Callable[[], None]) -> tuple[str, ...]:
    """The engines this runner advertises: both only after `verify` proved the isolation.

    A failed check drops `opencode` and keeps `pr-agent`; `pr-agent` runs in the same process
    boundary as before and needs none of this.
    """
    try:
        verify()
    except IsolationSelfCheckError:
        return (ENGINE_DIFF,)
    return ALL_ENGINES


def fail_closed_self_check() -> Callable[[], None]:
    """The configured check until #202 supplies the real probes: it never advertises `opencode`."""

    def check() -> None:
        raise IsolationSelfCheckError(
            ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED,
            "the isolation self-check is not configured yet",
        )

    return check
