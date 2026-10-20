# SPDX-License-Identifier: Apache-2.0

"""What the passthrough proxy tells an operator about usage it could not price (#551).

The only place in this package that logs, and it logs two things only: the **names** of usage fields
the parsers do not know (`usage_normalize.py` keeps them to short plain names; this is how the next
field of a provider's API is found, as `anthropic_cost.py` does), and a **count** of calls whose
charge the provider stated differently from the price book (`price_drift`). Never a value, a token
count, a cost, a model or a key.
"""

import logging
from collections.abc import Sequence

_log = logging.getLogger(__name__)


def log_unknown_fields(names: Sequence[str]) -> None:
    _log.warning("a model call has usage fields the proxy cannot price: %s", ", ".join(names))


def log_price_drift(calls: int) -> None:
    _log.warning("price_drift: %d call%s", calls, "" if calls == 1 else "s")
