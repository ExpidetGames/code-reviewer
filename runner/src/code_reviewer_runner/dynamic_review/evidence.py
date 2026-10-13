# SPDX-License-Identifier: Apache-2.0
"""Validated tracked trees and bounded exact endpoint evidence, independent of commit ancestry."""

import difflib
import json
import re
from collections import deque
from dataclasses import dataclass

from code_reviewer_runner.redaction import Redactor

from .content_policy import redact_text
from .limits import Budget, CheckoutError
from .objects import ObjectStore
from .paths import validate_path
from .protocol import fetch_pack
from .transport import Transport

_SHA = re.compile(r"[0-9a-f]{40}")
# Bound the (worst-case quadratic) line matcher; beyond this a full-body hunk is emitted, which
# the diff budget bounds as before.
_MAX_MATCH_LINES = 50_000
# Progressive history depths for the merge base. Each fetch is commits-only (tree:0); the walk
# gives up and declares a full review rather than guessing once these are exhausted.
_MERGE_BASE_DEPTHS = (16, 64, 256, 1024, 4096)


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


def commit_parents(store: ObjectStore, commit: str) -> list[str]:
    obj = store.objects.get(commit)
    if obj is None or obj.kind != "commit":
        return []
    parents: list[str] = []
    for line in store.read(commit, "commit").split(b"\n"):
        if line.startswith(b"parent "):
            parents.append(line[len(b"parent ") :].decode("ascii"))
        elif parents:
            break
    return parents


def merge_base(
    store: ObjectStore,
    transport: Transport,
    capabilities: set[str],
    head: str,
    base: str,
    budget: Budget,
) -> str | None:
    """Best common ancestor of head and base within a bounded, commits-only deepening.

    Returns ``None`` when the server cannot filter (no cheap ancestry walk) or no shared
    ancestor is found within the depth bound; the caller then declares a full review.
    """
    if "filter" not in capabilities:
        return None
    parents: dict[str, list[str]] = {}
    wants = (base,) if base == head else (base, head)
    for depth in _MERGE_BASE_DEPTHS:
        store.unpack(fetch_pack(transport, wants, capabilities, budget, history=depth))
        for oid, obj in store.objects.items():
            if obj.kind == "commit" and oid not in parents:
                parents[oid] = commit_parents(store, oid)
        result = _best_common_ancestor(head, base, parents)
        if result is not None:
            return result
    return None


def _best_common_ancestor(head: str, base: str, parents: dict[str, list[str]]) -> str | None:
    def distances(start: str) -> dict[str, int]:
        seen: dict[str, int] = {}
        queue: deque[tuple[str, int]] = deque([(start, 0)])
        while queue:
            commit, distance = queue.popleft()
            if commit in seen:
                continue
            seen[commit] = distance
            queue.extend(
                (parent, distance + 1)
                for parent in parents.get(commit, ())
                if parent in parents and parent not in seen
            )
        return seen

    from_head, from_base = distances(head), distances(base)
    common = from_head.keys() & from_base.keys()
    if not common:
        return None
    # A merge base is never deeper than any other common ancestor, so the shallowest common
    # commit from either tip is a merge base (there can be several on a criss-cross history).
    return min(common, key=lambda commit: (from_head[commit], from_base[commit], commit))


def endpoint_diff(
    left: dict[str, Entry],
    right: dict[str, Entry],
    cache: dict[str, str | None],
    budget: Budget,
    redactor: Redactor,
) -> str:
    # Exact two-endpoint diff. Line-level hunks with context keep a small change in a large file
    # from costing the whole file twice; a similarity search is not needed.
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
        before = cache.get(left[path].oid) if path in left else ""
        after = cache.get(right[path].oid) if path in right else ""
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
        if a == b:
            continue
        add(f"--- {name if path in left else '/dev/null'}\n")
        add(f"+++ {name if path in right else '/dev/null'}\n")
        for hunk in _hunks(a, b):
            add(hunk)
    return "".join(result)


def _hunks(a: list[str], b: list[str]) -> list[str]:
    if len(a) + len(b) > _MAX_MATCH_LINES:
        return _full_hunk(a, b)
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    hunks: list[str] = []
    for group in matcher.get_grouped_opcodes(3):
        start_a, stop_a = group[0][1], group[-1][2]
        start_b, stop_b = group[0][3], group[-1][4]
        hunks.append(f"@@ -{start_a + 1},{stop_a - start_a} +{start_b + 1},{stop_b - start_b} @@\n")
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                _emit(hunks, " ", a[i1:i2])
            elif tag == "delete":
                _emit(hunks, "-", a[i1:i2])
            elif tag == "insert":
                _emit(hunks, "+", b[j1:j2])
            else:
                _emit(hunks, "-", a[i1:i2])
                _emit(hunks, "+", b[j1:j2])
    return hunks


def _full_hunk(a: list[str], b: list[str]) -> list[str]:
    hunks = [f"@@ -1,{len(a)} +1,{len(b)} @@\n"]
    _emit(hunks, "-", a)
    _emit(hunks, "+", b)
    return hunks


def _emit(hunks: list[str], sign: str, lines: list[str]) -> None:
    for line in lines:
        hunks.append(sign + line)
        if not line.endswith("\n"):
            hunks.append("\n\\ No newline at end of file\n")
