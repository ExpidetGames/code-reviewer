# SPDX-License-Identifier: Apache-2.0
"""Cumulative budgets with a deadline: raw transfer, then materialization, then exposure.

A byte is counted once, in the budget of the resource it uses: the wire bytes against the
transfer budget, what the runner inflates and writes (staging, export, evidence, rounding)
against the preparation budget, and what the engine may read against the exposed budget.
"""

import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

from code_reviewer_runner.result import ErrorCode


class CheckoutReason(StrEnum):
    """Why preparation failed, as a stable value an operator and the Runs view can branch on.

    The `ErrorCode` stays what a caller branches on; the reason says which check inside the
    checkout refused. It never carries provider text, repository text or a path.
    """

    # The claim, a limit or a call argument is not acceptable.
    INVALID_REQUEST = "invalid_request"
    # The pull request's head ref no longer points at the queued commit.
    REF_MOVED = "ref_moved"
    # The base ref (or the pull request ref) is not advertised.
    REF_MISSING = "ref_missing"
    # The advertisement or the response framing is malformed.
    PROTOCOL = "protocol"
    # The PACK is corrupt, truncated, unsupported or lies about a size.
    PACK_INVALID = "pack_invalid"
    # An object that must be there is absent or of the wrong kind.
    OBJECT_MISSING = "object_missing"
    # A commit or tree is malformed.
    TREE_INVALID = "tree_invalid"
    # More tree entries (or pack objects) than the limit.
    ENTRIES = "entries"
    # A tracked path that cannot be exported safely.
    PATH_INVALID = "path_invalid"
    # The raw bytes received from the server exceeded the transfer budget.
    BUDGET_TRANSFER = "budget_transfer"
    # The bytes the runner materializes exceeded the preparation budget.
    BUDGET_PREPARATION = "budget_preparation"
    # The content exposed to the engine exceeded its budget.
    BUDGET_EXPOSED = "budget_exposed"
    # The endpoint diff exceeded its limit.
    DIFF_TOO_LARGE = "diff_too_large"
    # Metadata, prior state or the serialized evidence exceeded its limit.
    INPUT_TOO_LARGE = "input_too_large"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    # The Git server refused or could not be reached; the error code says how.
    TRANSPORT = "transport"
    # Export isolation could not be proven.
    ISOLATION = "isolation"
    # The pull request text or prior state could not be read.
    CONTEXT = "context"


@dataclass(frozen=True)
class CheckoutMetrics:
    """What one preparation cost and left out. Counts and stable reason names only.

    The three byte counters only grow during a run, so their final values are the peaks.
    """

    transfer_bytes: int
    preparation_bytes: int
    exposed_bytes: int
    # Tracked files of the head tree (directories are not counted).
    entries: int
    # Count per `OmissionReason` value / per `SkipReason` value; never a path.
    omitted: dict[str, int]
    skipped: dict[str, int]

    def describe(self) -> str:
        """One log line. Numbers and stable names only, so it is safe wherever a log goes."""

        def counts(values: dict[str, int]) -> str:
            return ",".join(f"{name}:{count}" for name, count in sorted(values.items())) or "none"

        return (
            f"transfer={self.transfer_bytes} preparation={self.preparation_bytes} "
            f"exposed={self.exposed_bytes} entries={self.entries} "
            f"omitted={counts(self.omitted)} skipped={counts(self.skipped)}"
        )


class CheckoutError(Exception):
    """Safe, stable failure: never include provider text, repository text or credentials."""

    def __init__(
        self, reason: CheckoutReason, code: ErrorCode = ErrorCode.CHECKOUT_INCOMPLETE
    ) -> None:
        self.code = code
        self.reason = reason
        # Set by the preparation that failed, so a failed run is as measurable as a good one.
        self.metrics: CheckoutMetrics | None = None
        super().__init__(code.value)


class ObjectUnavailable(CheckoutError):
    """The server explicitly refused a wanted object, or an exact tree is absent."""


@dataclass(frozen=True)
class Limits:
    entries: int = 20_000
    file_bytes: int = 512 * 1024
    exposed_bytes: int = 64 * 1024 * 1024
    transfer_bytes: int = 256 * 1024 * 1024
    preparation_bytes: int = 256 * 1024 * 1024
    diff_bytes: int = 2 * 1024 * 1024
    response_bytes: int = 1024 * 1024
    path_bytes: int = 1024
    path_depth: int = 32
    seconds: float = 300

    def __post_init__(self) -> None:
        values = (
            self.entries,
            self.file_bytes,
            self.exposed_bytes,
            self.transfer_bytes,
            self.preparation_bytes,
            self.diff_bytes,
            self.response_bytes,
            self.path_bytes,
            self.path_depth,
            self.seconds,
        )
        maxima = (
            20_000,
            512 * 1024,
            64 * 1024 * 1024,
            256 * 1024 * 1024,
            256 * 1024 * 1024,
            2 * 1024 * 1024,
            1024 * 1024,
            1024,
            32,
            300,
        )
        if any(
            not math.isfinite(value) or not 0 < value <= maximum
            for value, maximum in zip(values, maxima, strict=True)
        ):
            raise ValueError("checkout limits may only lower the fixed envelope")


class Budget:
    def __init__(self, limits: Limits, cancelled: Callable[[], bool] = lambda: False) -> None:
        self.limits = limits
        self.deadline = time.monotonic() + limits.seconds
        self.cancelled = cancelled
        self.transfer = 0
        self.preparation = 0
        self.exposed = 0

    def check(self) -> None:
        if self.cancelled():
            raise CheckoutError(CheckoutReason.CANCELLED)
        if time.monotonic() >= self.deadline:
            raise CheckoutError(CheckoutReason.TIMEOUT, ErrorCode.TIMEOUT)

    def remaining(self) -> float:
        self.check()
        return max(0.001, self.deadline - time.monotonic())

    def charge_transfer(self, count: int) -> None:
        """Raw bytes received from the server: HTTP framing, headers, advertisement and packs."""
        self.check()
        if count < 0:
            raise CheckoutError(CheckoutReason.INVALID_REQUEST)
        self.transfer += count
        if self.transfer > self.limits.transfer_bytes:
            raise CheckoutError(CheckoutReason.BUDGET_TRANSFER)

    def charge(self, count: int, *, exposed: bool = False) -> None:
        """Bytes the runner materializes (expansion, staging, export, evidence), or exposes."""
        self.check()
        if count < 0:
            raise CheckoutError(CheckoutReason.INVALID_REQUEST)
        if exposed:
            self.exposed += count
            if self.exposed > self.limits.exposed_bytes:
                raise CheckoutError(CheckoutReason.BUDGET_EXPOSED)
        else:
            self.preparation += count
            if self.preparation > self.limits.preparation_bytes:
                raise CheckoutError(CheckoutReason.BUDGET_PREPARATION)


DEFAULT_LIMITS = Limits()
