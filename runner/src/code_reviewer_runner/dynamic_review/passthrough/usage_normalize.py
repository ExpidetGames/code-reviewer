# SPDX-License-Identifier: Apache-2.0

"""The raw usage object of each family as a `CallUsage` (#551), failing closed.

Where the usage sits and what its fields are called is pinned by `fakes/wire/formats.py` (the
providers' documented shapes) and by `docs/spike/544-passthrough.md` section 5; every place a real
capture could still differ is marked UNCONFIRMED here and is an item of the live checklist (L14).

The rules, the same for the four families:

- a count the family must state (the prompt and the completion) that is missing, negative, boolean,
  fractional, textual or absurdly large makes the usage unreadable (None): it is never read as zero;
- a count the provider may leave out as a zero (the cache and the reasoning) is zero when absent,
  and a bad one, or one above what it is part of (a cache above the prompt, reasoning above the
  completion), or a split that disagrees with its flat total, puts the field's name in
  `unknown_fields`;
- a field the parser does not know whose value holds something (anything but null, false, zero, an
  empty string, list or object) is in `unknown_fields` too: it could carry a price. A zero of a
  kind we do not price costs nothing, so it is harmless. The few fields that are known and harmless
  but not zero (a total, the standard service tier) are in the schema below;
- a total the provider states (`total_tokens`, `totalTokenCount`) must be the sum of the counts of
  its family (Chat and Responses: prompt + completion; Google: prompt + candidates + thoughts + tool
  use); one that is not means the counts are not what the provider bills (xAI states reasoning on
  top of the completion), and the call is unknown (review of PR #569, S5);
- fields are named in `unknown_fields`, never their values, in a bounded plain form;
- nothing here recurses over what the provider sent: it may nest as deep as it likes (N1).

`audit` reads one statement of a usage alone, so that the tap can keep what every statement of a
stream said (a later one that leaves a field out must not hide it), and `went_backwards` says
whether a later statement states less than an earlier one.
"""

import re
from collections.abc import Callable, Collection, Iterable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Final, cast

from code_reviewer_runner.dynamic_review.budget import exact_cost
from code_reviewer_runner.dynamic_review.passthrough.call_usage import CallUsage
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily

# A single call never nears this; a count above it is not a count anybody can trust.
MAX_COUNT: Final = 10**12
MAX_UNKNOWN_FIELDS: Final = 16
_NAME: Final = re.compile(r"[A-Za-z0-9_]{1,40}")

type Benign = Callable[[Any], bool]
type Schema = dict[str, "Schema | Benign | None"]


def holds_something(value: object) -> bool:
    """Whether a field states a use: not null, false, zero, empty text, or a list or an object with
    nothing in it. A value of a kind we do not know counts as something. Iterative, so that a value
    nested as deep as the provider (or anybody on the way) wants cannot exhaust the stack."""
    pending: list[object] = [value]
    while pending:
        item = pending.pop()
        if item is None or item is False:
            continue
        if isinstance(item, (int, float)):
            if item != 0:
                return True
        elif isinstance(item, str):
            if item != "":
                return True
        elif isinstance(item, list):
            pending.extend(cast("list[object]", item))
        elif isinstance(item, dict):
            pending.extend(cast("dict[str, object]", item).values())
        else:
            return True
    return False


def _one_of(*allowed: object) -> Benign:
    return lambda value: value in allowed


def _nothing(value: Any) -> bool:
    return not holds_something(value)


def _anything(_: Any) -> bool:
    return True


def _text_only(value: Any) -> bool:
    """A per-modality breakdown (Google): only text carries tokens (the request has no other
    part)."""
    if value is None:
        return True
    if not isinstance(value, list):
        return False
    for entry in cast("list[object]", value):
        if not isinstance(entry, dict):
            return False
        fields = cast("dict[str, object]", entry)
        if fields.get("modality") != "TEXT" and holds_something(fields.get("tokenCount")):
            return False
    return True


# The standard service tier is the base price; any other (priority, flex, scale, batch) is a price
# the book does not know. Anthropic states `standard`, OpenAI `default`. UNCONFIRMED live (L14).
STANDARD_ANTHROPIC_TIERS: Final = (None, "standard")
STANDARD_OPENAI_TIERS: Final = (None, "default", "standard")

_CHAT: Final[Schema] = {
    "prompt_tokens": None,
    "completion_tokens": None,
    "total_tokens": None,
    "cost": None,
    # OpenRouter's breakdown of the charge it states in `cost`; informational, never read.
    # UNCONFIRMED live (L14), like `cost`, `is_byok` and `cache_write_tokens`.
    "cost_details": _anything,
    # OpenRouter says whether the upstream key was the account's own: then `cost` is not the whole.
    "is_byok": _one_of(None, False),
    "prompt_tokens_details": {"cached_tokens": None, "cache_write_tokens": None},
    "completion_tokens_details": {"reasoning_tokens": None},
    "prompt_cache_hit_tokens": None,
    "prompt_cache_miss_tokens": None,
}
_RESPONSES: Final[Schema] = {
    "input_tokens": None,
    "output_tokens": None,
    "total_tokens": None,
    "input_tokens_details": {"cached_tokens": None},
    "output_tokens_details": {"reasoning_tokens": None},
}
# As the legacy cost rule knows them (`anthropic_cost.py`, #511/#534), the same fields and the same
# harmless values.
_MESSAGES: Final[Schema] = {
    "input_tokens": None,
    "output_tokens": None,
    "cache_read_input_tokens": None,
    "cache_creation_input_tokens": None,
    "cache_creation": {"ephemeral_5m_input_tokens": None, "ephemeral_1h_input_tokens": None},
    "output_tokens_details": {"thinking_tokens": None},
    "service_tier": _one_of(*STANDARD_ANTHROPIC_TIERS),
    "speed": _one_of(None, "standard"),
    "inference_geo": _one_of(None, "", "global", "not_available"),
    "server_tool_use": _nothing,
    "iterations": _nothing,
}
_GOOGLE: Final[Schema] = {
    "promptTokenCount": None,
    "candidatesTokenCount": None,
    "thoughtsTokenCount": None,
    "cachedContentTokenCount": None,
    "totalTokenCount": None,
    "promptTokensDetails": _text_only,
    "candidatesTokensDetails": _text_only,
    "cacheTokensDetails": _text_only,
}


def _name(key: object) -> str:
    return key if isinstance(key, str) and _NAME.fullmatch(key) else "<name>"


def _walk(value: dict[str, Any], schema: Schema, path: str, unknown: set[str]) -> None:
    for key, item in value.items():
        where = f"{path}.{_name(key)}"
        if key not in schema:
            if holds_something(item):
                unknown.add(where)
            continue
        rule = schema[key]
        if rule is None:
            continue
        if isinstance(rule, dict):
            if isinstance(item, dict):
                _walk(item, rule, where, unknown)  # pyright: ignore[reportUnknownArgumentType]
            elif holds_something(item):
                unknown.add(where)
            continue
        if not rule(item):
            unknown.add(where)


class _Fields:
    """The counts of one usage object, collecting what cannot be trusted."""

    def __init__(self, usage: dict[str, Any], root: str) -> None:
        self.usage = usage
        self.root = root
        self.unknown: set[str] = set()

    def mark(self, *path: str) -> None:
        self.unknown.add(".".join((self.root, *path)))

    def _at(self, path: tuple[str, ...]) -> object:
        node: object = self.usage
        for key in path:
            if not isinstance(node, dict):
                return None
            node = cast("dict[str, object]", node).get(key)
        return node

    def stated(self, *path: str) -> int | None:
        """The count at `path`; None when it is absent or null, or bad (which is then marked)."""
        value = self._at(path)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_COUNT:
            self.mark(*path)
            return None
        return value

    def required(self, *path: str) -> int | None:
        """A count the provider must state: None when it is absent or bad."""
        return self.stated(*path)

    def optional(self, *path: str) -> int:
        """A count the provider may leave out as a zero."""
        return self.stated(*path) or 0

    def fit(self, part: int, whole: int, *path: str) -> None:
        if part > whole:
            self.mark(*path)

    def charge(self, *path: str) -> Decimal | None:
        """The charge the provider states: None when it states none, marked when it is no charge."""
        value = self._at(path)
        if value is None:
            return None
        cost = exact_cost(value)
        if cost is None:
            self.mark(*path)
        return cost

    def agree(self, first: int | None, second: int | None, *path: str) -> int | None:
        """Two statements of one count: the one that exists, or the first when both agree; a
        disagreement is marked."""
        if first is None or second is None:
            return second if first is None else first
        if first != second:
            self.mark(*path)
        return first


@dataclass(frozen=True)
class _Counts:
    prompt: int
    completion: int
    read: int = 0
    write_5m: int = 0
    write_1h: int = 0
    reasoning: int = 0
    stated_cost: Decimal | None = None
    stated_total: int | None = None


def _total(f: _Fields, expected: int) -> int | None:
    """A total the provider states must be the sum of the counts it states. Returned as stated,
    for the token cap of an own key (#553)."""
    total = f.stated(_TOTAL[f.root])
    if total is not None and total != expected:
        f.mark(_TOTAL[f.root])
    return total


def _chat(f: _Fields) -> _Counts | None:
    prompt, completion = f.required("prompt_tokens"), f.required("completion_tokens")
    if prompt is None or completion is None:
        return None
    total = _total(f, prompt + completion)
    # The cache is stated as `cached_tokens` (OpenAI, OpenRouter) or as DeepSeek's hit and miss
    # tokens (miss = prompt - hit): every statement there is must agree.
    read = f.agree(
        f.stated("prompt_tokens_details", "cached_tokens"),
        f.stated("prompt_cache_hit_tokens"),
        "prompt_cache_hit_tokens",
    )
    miss = f.stated("prompt_cache_miss_tokens")
    if miss is not None and miss > prompt:
        f.mark("prompt_cache_miss_tokens")
    elif miss is not None:
        read = f.agree(read, prompt - miss, "prompt_cache_miss_tokens")
    # OpenRouter's `cache_write_tokens`: the lifetime is not stated and the request cannot ask for
    # a 1-hour one, so it is a 5-minute write. UNCONFIRMED live (L14).
    written = f.optional("prompt_tokens_details", "cache_write_tokens")
    reasoning = f.optional("completion_tokens_details", "reasoning_tokens")
    read = read or 0
    f.fit(read + written, prompt, "prompt_tokens_details")
    f.fit(reasoning, completion, "completion_tokens_details", "reasoning_tokens")
    return _Counts(
        prompt,
        completion,
        read,
        written,
        0,
        reasoning,
        stated_cost=f.charge("cost"),
        stated_total=total,
    )


def _responses(f: _Fields) -> _Counts | None:
    prompt, completion = f.required("input_tokens"), f.required("output_tokens")
    if prompt is None or completion is None:
        return None
    total = _total(f, prompt + completion)
    read = f.optional("input_tokens_details", "cached_tokens")
    reasoning = f.optional("output_tokens_details", "reasoning_tokens")
    f.fit(read, prompt, "input_tokens_details", "cached_tokens")
    f.fit(reasoning, completion, "output_tokens_details", "reasoning_tokens")
    return _Counts(prompt, completion, read, reasoning=reasoning, stated_total=total)


def _messages(f: _Fields) -> _Counts | None:
    fresh, completion = f.required("input_tokens"), f.required("output_tokens")
    if fresh is None or completion is None:
        return None
    read = f.optional("cache_read_input_tokens")
    flat = f.stated("cache_creation_input_tokens")
    split_5m = f.stated("cache_creation", "ephemeral_5m_input_tokens")
    split_1h = f.stated("cache_creation", "ephemeral_1h_input_tokens")
    if split_5m is None and split_1h is None:
        # No split: the request can state no lifetime (`cache_control.ttl` is refused), so every
        # write is a 5-minute one.
        write_5m, write_1h = flat or 0, 0
    else:
        write_5m, write_1h = split_5m or 0, split_1h or 0
        if flat is not None and flat != write_5m + write_1h:
            f.mark("cache_creation")
    thinking = f.optional("output_tokens_details", "thinking_tokens")
    f.fit(thinking, completion, "output_tokens_details", "thinking_tokens")
    return _Counts(
        fresh + read + write_5m + write_1h, completion, read, write_5m, write_1h, thinking
    )


def _google(f: _Fields) -> _Counts | None:
    prompt = f.required("promptTokenCount")
    candidates, thoughts = f.stated("candidatesTokenCount"), f.stated("thoughtsTokenCount")
    # Gemini leaves a zero out (UNCONFIRMED live, L14); one of the two must be there for an output
    # to have been stated at all.
    if prompt is None or (candidates is None and thoughts is None):
        return None
    tool_use = f.optional("toolUsePromptTokenCount")
    total = _total(f, prompt + (candidates or 0) + (thoughts or 0) + tool_use)
    cached = f.optional("cachedContentTokenCount")
    f.fit(cached, prompt, "cachedContentTokenCount")
    # Thoughts are billed as output and are not part of the candidates. UNCONFIRMED live (L14).
    return _Counts(
        prompt,
        (candidates or 0) + (thoughts or 0),
        cached,
        reasoning=thoughts or 0,
        stated_total=total,
    )


_READERS: Final = {
    WireFamily.OPENAI_CHAT: _chat,
    WireFamily.OPENAI_RESPONSES: _responses,
    WireFamily.ANTHROPIC_MESSAGES: _messages,
    WireFamily.GOOGLE: _google,
}
_SCHEMAS: Final = {
    WireFamily.OPENAI_CHAT: _CHAT,
    WireFamily.OPENAI_RESPONSES: _RESPONSES,
    WireFamily.ANTHROPIC_MESSAGES: _MESSAGES,
    WireFamily.GOOGLE: _GOOGLE,
}
_ROOTS: Final = {
    WireFamily.OPENAI_CHAT: "usage",
    WireFamily.OPENAI_RESPONSES: "usage",
    WireFamily.ANTHROPIC_MESSAGES: "usage",
    WireFamily.GOOGLE: "usageMetadata",
}
_TOTAL: Final = {"usage": "total_tokens", "usageMetadata": "totalTokenCount"}
# Every count a family states, so that a bad one is marked wherever the reader gets to.
_COUNTS: Final[dict[WireFamily, tuple[tuple[str, ...], ...]]] = {
    WireFamily.OPENAI_CHAT: (
        ("prompt_tokens",),
        ("completion_tokens",),
        ("total_tokens",),
        ("prompt_tokens_details", "cached_tokens"),
        ("prompt_tokens_details", "cache_write_tokens"),
        ("completion_tokens_details", "reasoning_tokens"),
        ("prompt_cache_hit_tokens",),
        ("prompt_cache_miss_tokens",),
    ),
    WireFamily.OPENAI_RESPONSES: (
        ("input_tokens",),
        ("output_tokens",),
        ("total_tokens",),
        ("input_tokens_details", "cached_tokens"),
        ("output_tokens_details", "reasoning_tokens"),
    ),
    WireFamily.ANTHROPIC_MESSAGES: (
        ("input_tokens",),
        ("output_tokens",),
        ("cache_read_input_tokens",),
        ("cache_creation_input_tokens",),
        ("cache_creation", "ephemeral_5m_input_tokens"),
        ("cache_creation", "ephemeral_1h_input_tokens"),
        ("output_tokens_details", "thinking_tokens"),
    ),
    WireFamily.GOOGLE: (
        ("promptTokenCount",),
        ("candidatesTokenCount",),
        ("thoughtsTokenCount",),
        ("cachedContentTokenCount",),
        ("toolUsePromptTokenCount",),
        ("totalTokenCount",),
    ),
}


def _read(family: WireFamily, usage: dict[str, Any]) -> tuple[_Counts | None, set[str]]:
    """The counts of one usage object, and the names of everything in it that cannot be trusted."""
    root = _ROOTS[family]
    f = _Fields(usage, root)
    for path in _COUNTS[family]:
        f.stated(*path)
    counts = _READERS[family](f)
    _walk(usage, _SCHEMAS[family], root, f.unknown)
    return counts, f.unknown


def audit(family: WireFamily, usage: dict[str, Any]) -> frozenset[str]:
    """What cannot be trusted in this one statement of a usage, whether it is complete or not."""
    return frozenset(_read(family, usage)[1])


def normalize(
    family: WireFamily, usage: dict[str, Any], extra_unknown: Iterable[str] = ()
) -> CallUsage | None:
    """The usage of an answer as a `CallUsage` (complete, until the tap says it was not), or None
    when it does not state what every usage must. `extra_unknown` is what the rest of the answer
    (a service tier, a second choice, the other statements of a stream) already made unknown."""
    counts, marks = _read(family, usage)
    if counts is None:
        return None
    names = sorted({*marks, *extra_unknown})[:MAX_UNKNOWN_FIELDS]
    return CallUsage(
        prompt_tokens=counts.prompt,
        completion_tokens=counts.completion,
        cache_read=counts.read,
        cache_write_5m=counts.write_5m,
        cache_write_1h=counts.write_1h,
        reasoning_tokens=counts.reasoning,
        stated_cost=counts.stated_cost,
        stated_total=counts.stated_total,
        unknown_fields=tuple(names),
    )


def _leaves(usage: dict[str, Any]) -> dict[str, int]:
    """The whole-number fields of a usage object by their path (objects entered, lists not)."""
    found: dict[str, int] = {}
    pending: list[tuple[str, dict[str, Any]]] = [("", usage)]
    while pending:
        path, node = pending.pop()
        for key, item in node.items():
            where = f"{path}.{key}" if path else key
            if isinstance(item, dict):
                pending.append((where, cast("dict[str, Any]", item)))
            elif isinstance(item, int) and not isinstance(item, bool):
                found[where] = item
    return found


def went_backwards(
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    replaced: bool,
    ignore: Collection[str] = (),
) -> bool:
    """Whether `after` states less than `before` of some count. A usage only grows during a call.

    `replaced` is a statement that stands in place of the earlier one (Google's cumulative chunks):
    a count it leaves out has become zero. Otherwise it adds to the earlier one (Messages) and only
    the counts it states again are compared. `ignore` are counts of `before` that were only a
    placeholder."""
    earlier, later = _leaves(before), _leaves(after)
    for path, count in earlier.items():
        if path in ignore:
            continue
        if path in later:
            if later[path] < count:
                return True
        elif replaced and count > 0:
            return True
    return False
