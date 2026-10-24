# SPDX-License-Identifier: LicenseRef-Proprietary

"""Time as a dependency, so the loop's timing can be tested without waiting."""

import asyncio
import time
from typing import Protocol


class Clock(Protocol):
    def monotonic(self) -> float: ...

    def wall(self) -> float:
        """Seconds since the epoch: the clock of the times the app names (`leaseExpiresAt`)."""
        ...

    async def sleep(self, seconds: float) -> None: ...


class RealClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def wall(self) -> float:
        return time.time()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
