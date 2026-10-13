# SPDX-License-Identifier: Apache-2.0
"""One cumulative budget for transfer, expansion, metadata and export, with a deadline."""

import math
import time
from collections.abc import Callable
from dataclasses import dataclass

from code_reviewer_runner.result import ErrorCode


class CheckoutError(Exception):
    """Safe, stable failure: never include provider text, repository text or credentials."""

    def __init__(self, code: ErrorCode = ErrorCode.CHECKOUT_INCOMPLETE) -> None:
        self.code = code
        super().__init__(code.value)


class ObjectUnavailable(CheckoutError):
    """The server explicitly refused a wanted object, or an exact tree is absent."""


@dataclass(frozen=True)
class Limits:
    entries: int = 20_000
    file_bytes: int = 512 * 1024
    exposed_bytes: int = 64 * 1024 * 1024
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
        self.preparation = 0
        self.exposed = 0

    def check(self) -> None:
        if self.cancelled():
            raise CheckoutError()
        if time.monotonic() >= self.deadline:
            raise CheckoutError(ErrorCode.TIMEOUT)

    def remaining(self) -> float:
        self.check()
        return max(0.001, self.deadline - time.monotonic())

    def charge(self, count: int, *, exposed: bool = False) -> None:
        self.check()
        if count < 0:
            raise CheckoutError()
        if exposed:
            self.exposed += count
            if self.exposed > self.limits.exposed_bytes:
                raise CheckoutError()
        else:
            self.preparation += count
            if self.preparation > self.limits.preparation_bytes:
                raise CheckoutError()


DEFAULT_LIMITS = Limits()
