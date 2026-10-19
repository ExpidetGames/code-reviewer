# SPDX-License-Identifier: Apache-2.0

"""How the Messages API caches a prompt, for the Python fakes and tests (#539).

The prefix of a request (`tools`, then `system`, then `messages`, block by block) is cached up to
every block that carries `cache_control`; the next request that starts with the same blocks reads
that prefix instead of paying the input price for it. This module is the rules of that, from the
prompt caching page of the Claude docs, so a test can see a second turn read what the first wrote
and the usage it reports is the real shape (`input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens` and the `cache_creation` split, #534):

- at most four breakpoints (a top-level `cache_control` takes one: it marks the last cacheable
  block); more is a 400. A mark on an empty text block, an empty tool result or a thinking block is
  a 400, a `ttl` other than `5m` and `1h` is a 400, and so is a 1 hour entry after a 5 minute one;
- a mark where the API has no field for it is a 400 as well (`Extra inputs are not permitted`):
  the engine's own message-level marks must never reach the provider;
- a change of `tool_choice` or `thinking` invalidates the cached messages but not the tools and
  the system prompt; a change of the tool set (or of the system prompt) invalidates what follows it,
  which is the prefix chain itself;
- a prefix shorter than the model's minimum is not cached and no error is said;
- an entry lives 5 minutes (or 1 hour) from the start of the request that wrote or read it;
- a breakpoint looks for an entry at most 20 positions back (itself the first); a run of
  consecutive `tool_use` blocks counts as one position, and so does a run of `tool_result` blocks;
- a read costs `read` tokens, a write costs `written`, the rest of the input is `input_tokens`.

A token is a quarter of a character of the block's canonical JSON: only the proportions matter to
the tests, never the count. The same rules are in `server.ts` for the app's and the e2e lanes.
"""

import hashlib
import json
import math
import time
from collections.abc import Callable
from typing import Any

MAX_BREAKPOINTS = 4
LOOKBACK_BLOCKS = 20
FIVE_MINUTES = 300.0
ONE_HOUR = 3600.0

# The minimum cacheable prompt by model (the docs table). A model that is not here takes the
# highest, so a test cannot rely on a cache the real API would not make.
_MINIMUM_TOKENS = {
    "claude-fable-5-1": 512,
    "claude-opus-5-5": 512,
    "claude-opus-5": 512,
    "claude-sonnet-5-5": 512,
    "claude-fable-5": 512,
    "claude-haiku-5-5": 512,
    "claude-opus-4-8": 1024,
    "claude-sonnet-5": 1024,
    "claude-sonnet-4-6": 1024,
    "claude-opus-4-7": 2048,
    "claude-opus-4-6": 4096,
    "claude-opus-4-5": 4096,
    "claude-haiku-4-5": 4096,
}
_DEFAULT_MINIMUM = 4096
_MESSAGE_FIELDS = frozenset({"role", "content"})
_UNMARKABLE = frozenset({"thinking", "redacted_thinking"})


class CacheRequestRejected(Exception):
    """The API would answer 400 (`invalid_request_error`) with this message."""


def minimum_tokens(model: str) -> int:
    return _MINIMUM_TOKENS.get(model, _DEFAULT_MINIMUM)


def tokens_of(text: str) -> int:
    return math.ceil(len(text) / 4)


class _Block:
    def __init__(self, role: str, content: dict[str, Any], control: dict[str, Any] | None) -> None:
        self.role = role
        self.content = content
        self.control = control
        self.text = json.dumps(
            {"role": role, "block": content}, sort_keys=True, separators=(",", ":")
        )
        self.tokens = tokens_of(self.text)

    @property
    def markable(self) -> bool:
        kind = self.content.get("type")
        if kind in _UNMARKABLE:
            return False
        if kind == "tool_result":
            return bool(self.content.get("content"))
        return not (kind == "text" and not str(self.content.get("text", "")))


def _object(value: object) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None  # pyright: ignore[reportUnknownVariableType]


def _control(value: object, where: str) -> dict[str, Any] | None:
    if value is None:
        return None
    control = _object(value)
    if control is None or control.get("type") != "ephemeral":
        raise CacheRequestRejected(f"{where}.cache_control.type: Input should be 'ephemeral'")
    if control.get("ttl") not in (None, "5m", "1h"):
        raise CacheRequestRejected(f"{where}.cache_control.ttl: Input should be '5m' or '1h'")
    return control


def _without_control(block: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in block.items() if key != "cache_control"}


def _blocks(body: dict[str, Any]) -> list[_Block]:
    """The prompt as the cache sees it, in cache order."""
    blocks: list[_Block] = []
    tools: list[Any] = body.get("tools") or []
    for index, tool in enumerate(tools):
        entry = _object(tool)
        if entry is None:
            raise CacheRequestRejected(f"tools.{index}: Input should be an object")
        control = _control(entry.get("cache_control"), f"tools.{index}")
        blocks.append(_Block("tools", _without_control(entry), control))
    system: Any = body.get("system")
    if isinstance(system, str):
        blocks.append(_Block("system", {"type": "text", "text": system}, None))
    elif isinstance(system, list):
        parts: list[Any] = system  # pyright: ignore[reportUnknownVariableType]
        for index, part in enumerate(parts):
            entry = _object(part)
            if entry is None or entry.get("type") != "text":
                raise CacheRequestRejected(f"system.{index}: Input should be a text block")
            control = _control(entry.get("cache_control"), f"system.{index}")
            blocks.append(_Block("system", _without_control(entry), control))
    messages: list[Any] = body.get("messages") or []
    for index, raw in enumerate(messages):
        message = _object(raw)
        if message is None:
            raise CacheRequestRejected(f"messages.{index}: Input should be an object")
        extra = sorted(set(message) - _MESSAGE_FIELDS)
        if extra:
            raise CacheRequestRejected(
                f"messages.{index}.{extra[0]}: Extra inputs are not permitted"
            )
        role = str(message.get("role"))
        content: Any = message.get("content")
        if isinstance(content, str):
            blocks.append(_Block(role, {"type": "text", "text": content}, None))
            continue
        pieces: list[Any] = content if isinstance(content, list) else []  # pyright: ignore[reportUnknownVariableType]
        for position, piece in enumerate(pieces):
            entry = _object(piece)
            if entry is None:
                raise CacheRequestRejected(f"messages.{index}.content.{position}: bad block")
            control = _control(entry.get("cache_control"), f"messages.{index}.content.{position}")
            blocks.append(_Block(role, _without_control(entry), control))
    return blocks


def _settings_text(body: dict[str, Any]) -> str:
    """What a request says about tool use and thinking: the cached messages depend on it."""
    return json.dumps(
        {"tool_choice": body.get("tool_choice"), "thinking": body.get("thinking")},
        sort_keys=True,
        separators=(",", ":"),
    )


def _positions(blocks: list[_Block]) -> list[int]:
    """The position of every block for the look-back: a run of consecutive `tool_use` blocks is one
    position, and so is a run of `tool_result` blocks."""
    units: list[int] = []
    current = -1
    previous: tuple[str, str] | None = None
    for block in blocks:
        kind = str(block.content.get("type"))
        key = (block.role, kind)
        if previous is None or key != previous or kind not in ("tool_use", "tool_result"):
            current += 1
        previous = key
        units.append(current)
    return units


def breakpoints(body: dict[str, Any]) -> dict[int, dict[str, Any]]:
    """The marked blocks by position with their control, the automatic mark included; a request
    the API would refuse raises."""
    return _breakpoints(body, _blocks(body))


def _breakpoints(body: dict[str, Any], blocks: list[_Block]) -> dict[int, dict[str, Any]]:
    marked = {
        index: block.control for index, block in enumerate(blocks) if block.control is not None
    }
    for index in marked:
        kind = blocks[index].content.get("type")
        if not blocks[index].markable:
            raise CacheRequestRejected(
                "cache_control cannot be set for empty text blocks"
                if kind in ("text", "tool_result")
                else f"cache_control cannot be set on a {kind} block"
            )
    if "cache_control" in body:
        top = _control(body["cache_control"], "cache_control")
        eligible = [index for index, block in enumerate(blocks) if block.markable]
        if top is not None and eligible:
            last = eligible[-1]
            existing = marked.get(last)
            if existing is not None and existing.get("ttl") != top.get("ttl"):
                raise CacheRequestRejected("cache_control: conflicting ttl on the last block")
            marked.setdefault(last, top)
    if len(marked) > MAX_BREAKPOINTS:
        raise CacheRequestRejected(
            f"A maximum of {MAX_BREAKPOINTS} blocks with cache_control may be provided. "
            f"Found {len(marked)}."
        )
    seen_five = False
    for index in sorted(marked):
        one_hour = marked[index].get("ttl") == "1h"
        if one_hour and seen_five:
            raise CacheRequestRejected(
                "a ttl='1h' cache_control block must not come after a ttl='5m' one"
            )
        seen_five = seen_five or not one_hour
    return marked


class PromptCache:
    """The cache of one API key, and the usage a request gets from it."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._entries: dict[str, float] = {}

    def usage(
        self,
        body: dict[str, Any],
        base_usage: dict[str, Any],
        model: str | None = None,
        minimum: int | None = None,
    ) -> dict[str, Any]:
        """`base_usage` (the real shape of `Message.usage`) with the counts of this request.

        `base_usage["input_tokens"]` is ignored: the prompt is counted from the request. `minimum`
        replaces the model's minimum cacheable length (a model behind a router has another name).
        Raises `CacheRequestRejected` for a request the API would answer with a 400.
        """
        blocks = _blocks(body)
        controls = _breakpoints(body, blocks)
        marked = sorted(controls)
        now = self._clock()
        keys: list[str] = []
        previous = ""
        total = 0
        sums: list[int] = []
        settings = _settings_text(body)
        in_messages = False
        for block in blocks:
            if not in_messages and block.role not in ("tools", "system"):
                # Where the messages begin, the settings that apply to them join the prefix.
                in_messages = True
                previous = hashlib.sha256((previous + settings).encode()).hexdigest()
            previous = hashlib.sha256((previous + block.text).encode()).hexdigest()
            keys.append(previous)
            total += block.tokens
            sums.append(total)
        usage = dict(base_usage)
        floor = (
            minimum
            if minimum is not None
            else minimum_tokens(str(model if model is not None else body.get("model", "")))
        )
        usage.update(
            input_tokens=total,
            cache_creation_input_tokens=0,
            cache_read_input_tokens=0,
            cache_creation={"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0},
        )
        if not marked:
            return usage
        # A breakpoint reads the newest entry of the 20 positions up to and including itself.
        hit: int | None = None
        units = _positions(blocks)
        for position in reversed(marked):
            for candidate in range(position, -1, -1):
                if units[position] - units[candidate] >= LOOKBACK_BLOCKS:
                    break
                expires = self._entries.get(keys[candidate])
                if expires is not None and expires > now:
                    hit = candidate
                    break
            if hit is not None:
                break
        last = marked[-1]
        if sums[last] < floor:
            return usage
        lifetime = ONE_HOUR if controls[last].get("ttl") == "1h" else FIVE_MINUTES
        read = sums[hit] if hit is not None else 0
        written = sums[last] - read
        for position in marked:
            if sums[position] >= floor:
                self._entries[keys[position]] = now + lifetime
        if hit is not None:
            self._entries[keys[hit]] = now + lifetime
        usage.update(
            input_tokens=total - sums[last],
            cache_creation_input_tokens=written,
            cache_read_input_tokens=read,
            cache_creation={
                "ephemeral_5m_input_tokens": 0 if lifetime == ONE_HOUR else written,
                "ephemeral_1h_input_tokens": written if lifetime == ONE_HOUR else 0,
            },
        )
        return usage
