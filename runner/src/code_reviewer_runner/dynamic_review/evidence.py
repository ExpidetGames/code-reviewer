# SPDX-License-Identifier: Apache-2.0
"""Validated tracked trees and bounded exact endpoint evidence, independent of commit ancestry."""

import json
import re
from dataclasses import dataclass

from code_reviewer_runner.redaction import Redactor

from .content_policy import redact_text
from .limits import Budget, CheckoutError
from .objects import ObjectStore
from .paths import validate_path

_SHA = re.compile(r"[0-9a-f]{40}")


@dataclass(frozen=True)
class Entry:
    mode: str
    oid: str


def tracked_tree(store: ObjectStore, commit: str) -> dict[str, Entry]:
    raw = store.read(commit, "commit")
    first = raw.split(b"\n", 1)[0]
    if not first.startswith(b"tree ") or not _SHA.fullmatch(first[5:].decode("ascii")):
        raise CheckoutError()
    entries: dict[str, Entry] = {}
    count = 0

    def walk(oid: str, prefix: str) -> None:
        nonlocal count
        raw = store.read(oid, "tree")
        position = 0
        names: set[str] = set()
        while position < len(raw):
            store.budget.check()
            count += 1
            if count > store.budget.limits.entries:
                raise CheckoutError()
            space = raw.find(b" ", position)
            end = raw.find(b"\0", space + 1)
            if space < position or end < 0 or end + 21 > len(raw):
                raise CheckoutError()
            mode = raw[position:space].decode("ascii")
            name = raw[space + 1 : end].decode("utf-8")
            if "/" in name or name in names:
                raise CheckoutError()
            names.add(name)
            path = prefix + name
            validate_path(path, store.budget.limits)
            child = raw[end + 1 : end + 21].hex()
            position = end + 21
            if mode == "40000":
                walk(child, path + "/")
            else:
                entries[path] = Entry(mode, child)

    walk(first[5:].decode(), "")
    return entries


def changed_paths(left: dict[str, Entry], right: dict[str, Entry]) -> set[str]:
    return {path for path in left.keys() | right.keys() if left.get(path) != right.get(path)}


def endpoint_diff(
    left: dict[str, Entry],
    right: dict[str, Entry],
    cache: dict[str, str | None],
    budget: Budget,
    redactor: Redactor,
) -> str:
    # Exact two-endpoint diff, full-file hunks rather than an unbounded similarity search.
    result: list[str] = []
    size = 0

    def add(line: str) -> None:
        nonlocal size
        budget.check()
        size += len(line.encode())
        if size > budget.limits.diff_bytes:
            raise CheckoutError()
        result.append(line)

    for path in sorted(changed_paths(left, right)):
        before = cache[left[path].oid] if path in left else ""
        after = cache[right[path].oid] if path in right else ""
        if before is None or after is None:
            raise CheckoutError()
        a, b = before.splitlines(keepends=True), after.splitlines(keepends=True)
        name = json.dumps(redact_text(path, redactor), ensure_ascii=True)
        add(f"diff --git {name} {name}\n")
        if path not in left:
            add(f"new mode {right[path].mode}\n")
        elif path not in right:
            add(f"deleted mode {left[path].mode}\n")
        elif left[path].mode != right[path].mode:
            add(f"old mode {left[path].mode}\nnew mode {right[path].mode}\n")
        add(
            f"--- {name if path in left else '/dev/null'}\n"
            f"+++ {name if path in right else '/dev/null'}\n"
            f"@@ -1,{len(a)} +1,{len(b)} @@\n"
        )
        for sign, lines in (("-", a), ("+", b)):
            for line in lines:
                add(sign + line)
                if not line.endswith("\n"):
                    add("\n\\ No newline at end of file\n")
    return "".join(result)
