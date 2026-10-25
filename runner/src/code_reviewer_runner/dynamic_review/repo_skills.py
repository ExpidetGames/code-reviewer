# SPDX-License-Identifier: LicenseRef-Proprietary
"""Repository skills as documents the Dynamic Review agent can load (#701).

OpenCode (pinned v1.19.0) has its own skill mechanism: a `skill` tool that loads a `SKILL.md` and
lists every skill's name and description in the system prompt. The runner uses it as it is. A skill
is a document; the agent has no tool that runs a script (read, grep, glob, skill and the structured
return only), so a script in a skill tree is a readable file and nothing more.

What the pinned engine does with a skill, read from `packages/opencode/src/skill/index.ts` and
`tool/skill.ts` of v1.19.0 (the details are in docs/dynamic-checkout.md):

- It reads two frontmatter fields, `name` and `description`. Nothing else in a skill reaches a
  tool, a permission, a model, an agent or a provider; `allowed-tools`, `model` and the like are
  ignored.
- It parses the frontmatter with `gray-matter` 4.0.3, whose `---js` / `---javascript` first line
  runs the block through `eval` (checked against the package). A `SKILL.md` as written is therefore
  never given to the engine: `neutralize_skill_manifest` rewrites it.
- It puts `<name>` and `<description>` into the system prompt without escaping them.
- Its own discovery of `.claude/skills` and `.agents/skills` needs the flags the runner keeps off
  (they also reach the ancestors of the export), and `.opencode/skill(s)` is a project config
  directory, which `OPENCODE_DISABLE_PROJECT_CONFIG` keeps out. The runner-owned config lists the
  four root trees under `skills.paths` instead, which the engine scans for `**/SKILL.md` and
  nothing else.
"""

import json
import re

# The trees the runner-owned config hands the engine (`skills.paths`, relative to the export). Only
# these four root-level trees are exported; a nested one is not scanned and stays omitted.
SKILL_PATHS: tuple[str, ...] = (
    ".claude/skills",
    ".agents/skills",
    ".opencode/skill",
    ".opencode/skills",
)
_ROOTS = tuple(tuple(root.split("/")) for root in SKILL_PATHS)

# Plain text a skill may ship next to its `SKILL.md`: documents, data and scripts. A script is
# exported to be read, never to be run, and keeps no executable bit (the export is written as
# plain files). Everything else, a binary and anything unknown, is omitted.
_RESOURCE_SUFFIXES = frozenset(
    {
        ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc",
        ".json", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".xml", ".html", ".css", ".svg",
        ".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".rb",
        ".go", ".rs", ".java", ".kt", ".sql", ".ps1", ".lua", ".pl", ".php", ".c", ".h",
        ".cpp", ".hpp", ".cs", ".swift", ".tmpl", ".j2",
    }
)  # fmt: skip
_RESOURCE_NAMES = frozenset({"license", "notice", "readme", "changelog"})
# Names that configure or extend the engine, or an installer, wherever they sit in a skill tree.
_DENIED_NAMES = frozenset(
    {
        "opencode.json",
        "opencode.jsonc",
        "tui.json",
        "tui.jsonc",
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
        "bunfig.toml",
        "mcp.json",
        ".mcp.json",
    }
)
_DENIED_DIRS = frozenset({".opencode", "node_modules"})

_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
# The skill the engine ships itself; the permission block hides it, so a repository skill of that
# name would be unusable. It is refused instead of silently hidden.
_RESERVED_NAMES = frozenset({"customize-opencode"})
MAX_DESCRIPTION_CHARS = 300
_ELLIPSIS = "…"
# What the engine lists for every skill in the system prompt of every request is bounded: at most
# this many skills, and their names and descriptions together at most this many UTF-8 bytes. The
# first skills by path are exported, the rest are omitted (`skill_limit`).
MAX_SKILLS = 50
MAX_SKILL_LISTING_BYTES = 8 * 1024
_KEY = re.compile(r"([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)")
_ESCAPES = {"<": "&lt;", ">": "&gt;"}
_BLOCK_SCALAR = re.compile(r"[|>][+-]?[0-9]?")


def is_skill_resource(path: str) -> bool:
    """Whether `path` is a file of a skill in one of the four root trees.

    The root names match exactly (the engine scans exactly these spellings), the file sits in a
    skill directory below the tree and not in the tree itself, and neither its path nor its name
    is one that configures the engine or installs a package.
    """
    parts = path.split("/")
    for root in _ROOTS:
        if tuple(parts[: len(root)]) != root:
            continue
        inside = parts[len(root) :]
        if len(inside) < 2:
            return False
        if any(part.lower() in _DENIED_DIRS for part in inside[:-1]):
            return False
        return _resource_name_allowed(inside[-1])
    return False


def _resource_name_allowed(name: str) -> bool:
    lowered = name.lower()
    if lowered in _DENIED_NAMES or lowered.startswith(".env"):
        return False
    if lowered in _RESOURCE_NAMES:
        return True
    suffix = lowered[lowered.rfind(".") :] if "." in lowered else ""
    return suffix in _RESOURCE_SUFFIXES


def is_skill_manifest(path: str) -> bool:
    """A file the engine may take for a skill: any spelling of `SKILL.md` in a skill tree."""
    return is_skill_resource(path) and path.rsplit("/", 1)[-1].lower() == "skill.md"


def neutralize_skill_manifest(text: str) -> str | None:
    """The `SKILL.md` the engine is given, or None when the skill is not exported.

    The frontmatter is rebuilt from the two fields the engine uses, as two JSON strings (valid
    YAML double-quoted scalars), so no other key, no language marker and no tag reaches the
    engine's parser. The body is the document and stays as it was. A manifest that does not start
    with a plain `---` line, never closes it, or has no usable name and description is refused.
    """
    lines = text.removeprefix("﻿").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if lines[0] != "---":
        return None
    end = next((i for i in range(1, len(lines)) if lines[i].rstrip() == "---"), None)
    if end is None:
        return None
    fields = _fields(lines[1:end])
    if fields is None:
        return None
    name = fields.get("name", "").strip()
    description = _description(fields.get("description", ""))
    if _NAME.fullmatch(name) is None or name.lower() in _RESERVED_NAMES or not description:
        return None
    body = "\n".join(lines[end + 1 :])
    head = f"---\nname: {_quote(name)}\ndescription: {_quote(description)}\n---\n"
    return head + body


def _quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def admit_skills(manifests: dict[str, str]) -> set[str]:
    """The paths of the rewritten manifests that are exported: the first by path, within the bounds.

    `manifests` maps a path to the text `neutralize_skill_manifest` returned. The walk is in path
    order and stops at the first skill that does not fit, so the outcome never depends on the order
    the objects were read in and a later, smaller skill cannot take the place of an earlier one.
    """
    admitted: set[str] = set()
    listing = 0
    for path in sorted(manifests):
        listing += _listing_bytes(manifests[path])
        if len(admitted) >= MAX_SKILLS or listing > MAX_SKILL_LISTING_BYTES:
            break
        admitted.add(path)
    return admitted


def _listing_bytes(manifest: str) -> int:
    """The bytes a rewritten manifest adds to the engine's skill listing (name and description)."""
    lines = manifest.split("\n")
    name = json.loads(lines[1].removeprefix("name: "))
    description = json.loads(lines[2].removeprefix("description: "))
    return len(name.encode()) + len(description.encode())


def _description(value: str) -> str:
    """One bounded printable line that cannot close the tag the engine writes it into.

    The bound is on the escaped text, which is what the engine writes, and a cut ends in an
    ellipsis and never inside an escape.
    """
    line = "".join(char for char in " ".join(value.split()) if char.isprintable())
    escaped = [_ESCAPES.get(char, char) for char in line]
    if sum(map(len, escaped)) <= MAX_DESCRIPTION_CHARS:
        return "".join(escaped)
    kept: list[str] = []
    size = len(_ELLIPSIS)
    for piece in escaped:
        size += len(piece)
        if size > MAX_DESCRIPTION_CHARS:
            break
        kept.append(piece)
    return "".join(kept).rstrip() + _ELLIPSIS


def _fields(lines: list[str]) -> dict[str, str] | None:
    """The `name` and `description` of a frontmatter block; None for a key given twice.

    A small reader on purpose: it takes the scalar forms a skill uses (plain, quoted, folded and
    literal blocks, indented continuation) and does not interpret anything else, so there is no
    YAML feature to reach. The value is read like the engine's fallback does for an unquoted colon.
    """
    wanted = ("name", "description")
    found: dict[str, str] = {}
    index = 0
    while index < len(lines):
        match = _KEY.fullmatch(lines[index])
        index += 1
        key = match.group(1) if match else None
        continuation: list[str] = []
        while index < len(lines) and (not lines[index].strip() or lines[index][0] in " \t"):
            continuation.append(lines[index].strip())
            index += 1
        if match is None or key not in wanted:
            continue
        if key in found:
            return None
        found[key] = _scalar(match.group(2).strip(), [c for c in continuation if c])
    return found


def _scalar(first: str, continuation: list[str]) -> str:
    if _BLOCK_SCALAR.fullmatch(first):
        return " ".join(continuation)
    joined = " ".join([first, *continuation]) if first else " ".join(continuation)
    if joined.startswith('"'):
        return _double_quoted(joined)
    if joined.startswith("'"):
        end = joined.rfind("'")
        return joined[1:end].replace("''", "'") if end > 0 else joined[1:]
    return joined.split(" #", 1)[0].strip()


def _double_quoted(value: str) -> str:
    try:
        decoded = json.loads(value)
    except ValueError:
        end = value.rfind('"')
        return value[1:end] if end > 0 else value[1:]
    return decoded if isinstance(decoded, str) else value
