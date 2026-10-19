# SPDX-License-Identifier: Apache-2.0

"""The thinking blocks of a Dynamic run on a model that cannot run without thinking (#533).

Fable 5.1, Opus 5.5, Sonnet 5.5 and Fable 5 think on every call, and the Messages API wants the
`thinking` and `redacted_thinking` blocks of an answer back, unchanged and in order, when the tool
results of that answer are sent (`build-with-claude/thinking`, "Preserving thinking blocks"). The
engine talks the chat protocol, whose history cannot hold them, so the engine never sees them: the
wire keeps the blocks of every answer here and puts them back into the assistant turn that carries
the same tool calls on the next request.

An assistant turn is found by what the engine's history keeps of it: the ids of its tool calls (an
id is unique per call), or, for a turn with no tool call, its text. The order of the blocks within
the answer is kept, so a thinking block between a text and a tool call is replayed between them.
Nothing is invented: a turn the wire has no record of (another run, a turn the proxy wrote itself)
goes out as the engine has it.

One store belongs to one wire, which belongs to one job.
"""

import copy
import hashlib
import threading
from typing import Any, Final

THINKING_KINDS: Final = ("thinking", "redacted_thinking")
_TEXT_KEY: Final = "text:"

# One entry of a remembered answer, in the order of the answer.
_Entry = tuple[str, Any]


def _text_key(text: str) -> str:
    return _TEXT_KEY + hashlib.sha256(text.strip().encode("utf-8")).hexdigest()


class ThinkingStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._answers: dict[str, list[_Entry]] = {}

    def remember(self, content: list[dict[str, Any]]) -> None:
        """Keep the thinking blocks of an answer (its content blocks, as the API sent them)."""
        sequence: list[_Entry] = []
        tool_ids: list[str] = []
        texts: list[str] = []
        for block in content:
            kind = block.get("type")
            if kind in THINKING_KINDS:
                sequence.append(("thinking", copy.deepcopy(block)))
            elif kind == "text" and isinstance(block.get("text"), str):
                sequence.append(("text", None))
                texts.append(block["text"])
            elif kind == "tool_use" and isinstance(block.get("id"), str):
                sequence.append(("tool", block["id"]))
                tool_ids.append(block["id"])
        if not any(entry[0] == "thinking" for entry in sequence):
            return
        keys = tool_ids or [_text_key("".join(texts))]
        with self._lock:
            for key in keys:
                self._answers[key] = sequence

    def restore(self, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The blocks of an assistant turn (text and tool calls as the engine has them) with the
        thinking blocks of the answer they came from put back where the model had them."""
        tool_blocks = {
            block["id"]: block
            for block in blocks
            if block.get("type") == "tool_use" and isinstance(block.get("id"), str)
        }
        texts = [block for block in blocks if block.get("type") == "text"]
        if tool_blocks:
            key = next(iter(tool_blocks))
        elif texts:
            key = _text_key("".join(str(block.get("text")) for block in texts))
        else:
            return blocks
        with self._lock:
            sequence = self._answers.get(key)
        if sequence is None:
            return blocks
        restored: list[dict[str, Any]] = []
        used: set[int] = set()
        remaining_texts = list(texts)
        for kind, value in sequence:
            if kind == "thinking":
                restored.append(copy.deepcopy(value))
            elif kind == "text" and remaining_texts:
                block = remaining_texts.pop(0)
                restored.append(block)
                used.add(id(block))
            elif kind == "tool" and value in tool_blocks:
                block = tool_blocks[value]
                restored.append(block)
                used.add(id(block))
        restored.extend(block for block in blocks if id(block) not in used)
        return restored
