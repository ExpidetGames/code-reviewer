# SPDX-License-Identifier: Apache-2.0

"""What the Claude Messages API refuses with a 400, for the Python fakes (#533).

The TypeScript fake (`anthropic-rules.ts`) has a twin of this module, and both answer the same
table of cases (`anthropic-rule-cases.json`). The flags that decide a case come from the contract
file of the model list (`contracts/anthropic-models.v1.json`), never from a second list and never
from an id.

The rules, read from Anthropic's documentation on 2026-10-19 (`build-with-claude/thinking`,
`agents-and-tools/tool-use/define-tools`):

- a forced `tool_choice` (`any` or a named tool) is a 400 on a model whose `forcedToolChoice` flag
  is off;
- `thinking: {type: "disabled"}` (and a budget) is a 400 on a model whose `thinkingDisabled` flag
  is off;
- `thinking.block_binding` is a 400 without the beta header
  `thinking-binding-controls-2026-08-01`;
- thinking blocks of an answer must come back unchanged, in order, at the head of the assistant
  turn that holds the same tool calls (`record` remembers what was issued);
- a thinking block is bound to the conversation that produced it: when the `system` text or the
  set of tools differs from the request that produced it, the request is a 400 unless it asks for
  `prefix_mismatch_behavior: "drop_block"` (an account created after 2026-08-31 is enforced).

One rule is an ASSUMPTION, not a documented one: the 400 for an assistant turn with `tool_use` that
lacks its thinking blocks altogether (`content[:len(blocks)] != blocks` in `_replayed`). The
documentation says the blocks are "required" within a tool-use turn and that modified blocks are a
400, but it does not state the status code for omitted ones. The fake takes the conservative reading
so that a wire which dropped the blocks cannot pass; the manual smoke run of #519 has to confirm it.

A fake that is stricter than the real API would hide a bug as much as a lenient one; each rule
here is a documented one."""

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Final, cast

CONTRACT: Final = Path(__file__).resolve().parents[2] / "contracts" / "anthropic-models.v1.json"
BETA_HEADER: Final = "thinking-binding-controls-2026-08-01"
_THINKING_KINDS: Final = ("thinking", "redacted_thinking")

Refusal = tuple[int, dict[str, Any]]


def models() -> dict[str, dict[str, Any]]:
    """The model list of the contract file by id."""
    document: dict[str, Any] = json.loads(CONTRACT.read_text(encoding="utf-8"))
    return {entry["id"]: entry for entry in document["models"]}


def invalid(message: str) -> Refusal:
    """Anthropic's error envelope for a request it refuses."""
    return 400, {"type": "error", "error": {"type": "invalid_request_error", "message": message}}


def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()


def _object(value: object) -> dict[str, Any] | None:
    """The value as a JSON object, or None."""
    return cast("dict[str, Any]", value) if isinstance(value, dict) else None


def _list(value: object) -> list[Any]:
    return cast("list[Any]", value) if isinstance(value, list) else []


def _tool_names(body: Mapping[str, Any]) -> list[str]:
    names: list[str] = []
    for tool in _list(body.get("tools")):
        entry = _object(tool)
        if entry is not None and "name" in entry:
            names.append(str(entry["name"]))
    return sorted(names)


def _system_text(body: Mapping[str, Any]) -> str:
    system: Any = body.get("system")
    return system if isinstance(system, str) else json.dumps(system, sort_keys=True)


def _conversation(body: Mapping[str, Any]) -> str:
    """What a thinking block is bound to here: the system text and the set of tools."""
    return _digest([_system_text(body), _tool_names(body)])


def _blocks(message: object) -> list[dict[str, Any]]:
    entry = _object(message)
    content = _list(entry.get("content")) if entry is not None else []
    blocks = (_object(block) for block in content)
    return [block for block in blocks if block is not None]


def _behavior(body: Mapping[str, Any]) -> object:
    """What the request says happens to a thinking block that no longer fits the conversation."""
    thinking = _object(body.get("thinking"))
    binding = _object(thinking.get("block_binding")) if thinking is not None else None
    return binding.get("prefix_mismatch_behavior") if binding is not None else None


class StrictMessagesApi:
    """The checks of one fake, with the memory of the thinking blocks it issued."""

    def __init__(self) -> None:
        self._models = models()
        # By tool call id: the thinking blocks issued with it, and the conversation they bind to.
        self._issued: dict[str, tuple[list[dict[str, Any]], str]] = {}

    def record(self, request: Mapping[str, Any], answer: Mapping[str, Any]) -> None:
        """Remember the thinking blocks an answer carries, for the requests that replay them."""
        content = _blocks(answer)
        thinking = [block for block in content if block.get("type") in _THINKING_KINDS]
        if not thinking:
            return
        bound = _conversation(request)
        for block in content:
            if block.get("type") == "tool_use" and isinstance(block.get("id"), str):
                self._issued[block["id"]] = (thinking, bound)

    def check(self, headers: Mapping[str, str], body: Mapping[str, Any]) -> Refusal | None:
        """The 400 of a request the API refuses, or None. A model of no list is not judged here."""
        model = self._models.get(str(body.get("model")))
        if model is None:
            return None
        supports: dict[str, Any] = model["supports"]
        refusal = self._choice(body, supports) or self._thinking(headers, body, supports)
        return refusal or self._replayed(body)

    @staticmethod
    def _choice(body: Mapping[str, Any], supports: Mapping[str, Any]) -> Refusal | None:
        choice = _object(body.get("tool_choice"))
        kind = choice.get("type") if choice is not None else None
        if kind in ("any", "tool") and not supports["forcedToolChoice"]:
            return invalid('tool_choice: type "tool" and "any" are not supported for this model.')
        return None

    @staticmethod
    def _thinking(
        headers: Mapping[str, str], body: Mapping[str, Any], supports: Mapping[str, Any]
    ) -> Refusal | None:
        thinking = _object(body.get("thinking"))
        if thinking is None:
            return None
        kind = thinking.get("type")
        if kind in ("disabled", "enabled") and not supports["thinkingDisabled"]:
            return invalid(f'thinking.type.{kind}: "{kind}" is not supported for this model.')
        if "block_binding" not in thinking:
            return None
        if BETA_HEADER not in headers.get("anthropic-beta", ""):
            return invalid("thinking.block_binding: Extra inputs are not permitted")
        if _behavior(body) not in ("error", "drop_block"):
            return invalid("thinking.block_binding.prefix_mismatch_behavior is not valid")
        return None

    def _replayed(self, body: Mapping[str, Any]) -> Refusal | None:
        bound = _conversation(body)
        for index, message in enumerate(_list(body.get("messages"))):
            entry = _object(message)
            if entry is None or entry.get("role") != "assistant":
                continue
            content = _blocks(entry)
            ids = [
                block["id"]
                for block in content
                if block.get("type") == "tool_use" and isinstance(block.get("id"), str)
            ]
            issued = next((self._issued[call] for call in ids if call in self._issued), None)
            if issued is None:
                continue
            blocks, original = issued
            if content[: len(blocks)] != blocks:
                return invalid(
                    f"messages.{index}.content: `thinking` or `redacted_thinking` blocks in the "
                    "latest assistant message cannot be modified. These blocks must remain as they "
                    "were in the original response."
                )
            if bound != original and _behavior(body) != "drop_block":
                return invalid(
                    f"messages.{index}.content.0: Invalid `signature` in `thinking` block. The "
                    "block is bound to a different conversation. Remove the block, or set "
                    '`thinking.block_binding.prefix_mismatch_behavior` to "drop_block".'
                )
        return None
