"""One in-memory rate limit: requests per client address per minute.

Fixed one-minute windows, counted in the event loop thread, so no lock is needed.
"""

from __future__ import annotations

import math
import time
from typing import Callable

from facescan_api.errors import retry_after

WINDOW_S = 60


class RateLimiter:
    def __init__(self, limit: int, *, clock: Callable[[], float] = time.time, max_keys: int = 100_000) -> None:
        self.limit = limit
        self._clock = clock
        self._max_keys = max_keys
        self._counts: dict[str, tuple[int, int]] = {}   # address → (window, count)

    def hit(self, address: str) -> None:
        """Count one request; raises 429 ``rate_limited`` (with ``Retry-After``) over the limit."""
        now = self._clock()
        window = int(now // WINDOW_S)
        if len(self._counts) >= self._max_keys:
            self._counts = {k: v for k, v in self._counts.items() if v[0] == window}
        w, count = self._counts.get(address, (window, 0))
        count = count + 1 if w == window else 1
        self._counts[address] = (window, count)
        if count > self.limit:
            raise retry_after("rate_limited", math.ceil((window + 1) * WINDOW_S - now),
                              f"rate limit of {self.limit} requests per minute reached")
