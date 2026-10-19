# SPDX-License-Identifier: Apache-2.0

"""The cost of an Anthropic call, worked out from the usage the call reports (#511).

Anthropic states token counts and no charge. Billing charges the real cost of a call, so the number
is computed from the counts and the price list of the model (`anthropic_models.py`) and is exact
(`Decimal`, no float): every kind of token at its own price, and the higher tier of the models that
have one. A call that cannot be priced exactly has **no** cost (`None`), never zero:

- a model that is not in the list;
- a usage that cannot be read (a missing, negative, fractional, boolean or absurdly large count,
  cache counts that do not fit the prompt, a cache write split that does not add up) or that holds
  no token at all: every real answer has input and output tokens (an empty reply still has output
  tokens), so a usage of nothing is a usage that was left out, which LiteLLM fills with zeros;
- a call that carries a charge the table does not know: a tier other than the standard one, the fast
  mode, an inference region other than the default one, a server tool such as web search, or
  per-iteration usage, or any other field of the usage that holds something and that the standard
  token fields do not name. Both checks deny by default: what Anthropic adds later is an unknown
  cost until this table learns it.

The usage is read in the shape LiteLLM gives it and the Dynamic proxy translates Anthropic's answer
into (`prompt_tokens` holds the cache tokens, which are also named on their own), as a mapping or as
an object. A cache write without a split is priced as a five minute write, the lifetime the runner's
requests use.
"""

from collections.abc import Mapping
from decimal import Context, Decimal
from typing import Any, Final

from code_reviewer_runner.anthropic_models import ClaudeModel, Prices, model_for
from code_reviewer_runner.usage_access import usage_field

# Wide enough that no sum of five products of a count under `_MAX_TOKENS` and a price loses a digit.
_EXACT: Final = Context(prec=80)
_PER_MILLION: Final = Decimal(1_000_000)
# A single call never nears this; a count above it is not a count anybody can trust.
_MAX_TOKENS: Final = 10**9
_STANDARD_TIERS: Final = (None, "standard")
_STANDARD_REGIONS: Final = (None, "", "global", "not_available")
# Every field of a usage the cost rule reads, checks on its own or deliberately ignores (a charge
# some layer states itself is never trusted, see `_IGNORED_FIELDS`); any other that holds something
# is a charge the table does not know.
_IGNORED_FIELDS: Final = frozenset({"cost", "total_cost", "response_cost"})
_KNOWN_FIELDS: Final = _IGNORED_FIELDS | frozenset(
    {
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "prompt_tokens_details",
        "completion_tokens_details",
        "service_tier",
        "speed",
        "inference_geo",
        "server_tool_use",
        "iterations",
    }
)


def _count(value: object, *, default: int | None = None) -> int | None:
    """A whole, non-negative token count: `default` for a missing value, None for a bad one."""
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > _MAX_TOKENS:
        return None
    return value


def _holds_something(value: object) -> bool:
    """Whether a field states a use: not None, zero, false or empty."""
    return value is not None and value != 0 and value != "" and value != [] and value != {}


def _fields(usage: Any) -> Mapping[str, Any]:
    """The fields of a usage, as a mapping, whether it is one or an object (LiteLLM's `Usage`)."""
    if isinstance(usage, Mapping):
        return usage  # pyright: ignore[reportUnknownVariableType]
    dump = getattr(usage, "model_dump", None)
    if callable(dump):
        dumped: Any = dump()
        if isinstance(dumped, Mapping):
            return dumped  # pyright: ignore[reportUnknownVariableType]
    attributes: object = getattr(usage, "__dict__", None)
    return attributes if isinstance(attributes, dict) else {}  # pyright: ignore[reportUnknownVariableType]


def _uses_server_tools(usage: object) -> bool:
    """Any entry of `server_tool_use` that is not a zero: the table prices none of them. A value
    that is not a record of counts cannot be read, so it counts as a use."""
    server_tools: object = usage_field(usage, "server_tool_use")
    if server_tools is None:
        return False
    if not isinstance(server_tools, Mapping) and not hasattr(server_tools, "__dict__"):
        return True
    return any(_holds_something(value) for value in _fields(server_tools).values())


def _has_unpriced_charge(usage: object) -> bool:
    if usage_field(usage, "service_tier") not in _STANDARD_TIERS:
        return True
    if usage_field(usage, "speed") not in _STANDARD_TIERS:
        return True
    if usage_field(usage, "inference_geo") not in _STANDARD_REGIONS:
        return True
    if _uses_server_tools(usage):
        return True
    if any(
        name not in _KNOWN_FIELDS and _holds_something(value)
        for name, value in _fields(usage).items()
    ):
        return True
    iterations = usage_field(usage, "iterations")
    return iterations is not None and bool(iterations)


class _Tokens:
    """The counts of one call, each kind on its own."""

    def __init__(self, uncached: int, output: int, read: int, write_5m: int, write_1h: int) -> None:
        self.uncached = uncached
        self.output = output
        self.read = read
        self.write_5m = write_5m
        self.write_1h = write_1h

    @property
    def prompt(self) -> int:
        """The length of the prompt as Anthropic prices it: every input token, cached or not."""
        return self.uncached + self.read + self.write_5m + self.write_1h


def _tokens(usage: object) -> _Tokens | None:
    prompt = _count(usage_field(usage, "prompt_tokens"))
    output = _count(usage_field(usage, "completion_tokens"))
    read = _count(usage_field(usage, "cache_read_input_tokens"), default=0)
    written = _count(usage_field(usage, "cache_creation_input_tokens"), default=0)
    if prompt is None or output is None or read is None or written is None:
        return None
    uncached = prompt - read - written
    if uncached < 0 or prompt + output == 0:
        return None
    write_5m, write_1h = written, 0
    details = usage_field(
        usage_field(usage, "prompt_tokens_details"), "cache_creation_token_details"
    )
    if details is not None:
        split_5m = _count(usage_field(details, "ephemeral_5m_input_tokens"), default=0)
        split_1h = _count(usage_field(details, "ephemeral_1h_input_tokens"), default=0)
        if split_5m is None or split_1h is None or split_5m + split_1h != written:
            return None
        write_5m, write_1h = split_5m, split_1h
    return _Tokens(uncached, output, read, write_5m, write_1h)


def _prices_for(model: ClaudeModel, tokens: _Tokens) -> Prices:
    tier = model.long_prompt
    if tier is not None and tokens.prompt > tier.over_input_tokens:
        return tier.prices
    return model.prices


def cost_of_usage(model_id: str, usage: object) -> Decimal | None:
    """The exact USD cost of one call to `model_id` with this usage, or None if it cannot be priced.

    `model_id` is the bare Claude API id (no routing prefix).
    """
    model = model_for(model_id)
    if model is None or usage is None or _has_unpriced_charge(usage):
        return None
    tokens = _tokens(usage)
    if tokens is None:
        return None
    prices = _prices_for(model, tokens)
    total = _EXACT.add(
        _EXACT.add(
            _EXACT.add(
                _EXACT.multiply(Decimal(tokens.uncached), prices.input),
                _EXACT.multiply(Decimal(tokens.output), prices.output),
            ),
            _EXACT.add(
                _EXACT.multiply(Decimal(tokens.read), prices.cache_read),
                _EXACT.multiply(Decimal(tokens.write_5m), prices.cache_write_5m),
            ),
        ),
        _EXACT.multiply(Decimal(tokens.write_1h), prices.cache_write_1h),
    )
    return _EXACT.divide(total, _PER_MILLION) if total else Decimal(0)
