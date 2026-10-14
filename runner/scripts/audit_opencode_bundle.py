# SPDX-License-Identifier: Apache-2.0

"""Writes the snapshot of the npm packages that the pinned OpenCode binary may contain (#202).

The OpenCode release is a Bun-compiled executable. Its bundled JavaScript dependencies are not
visible to the npm or uv collectors of `make check-licenses`, and the binary does not say which
modules the bundler embedded. This script therefore works from the source of the pinned release:

1. it reads the upstream `bun.lock` at the commit named in `runner/opencode-pin.json`;
2. it computes the production dependency closure of the workspace `packages/opencode` (the
   `dependencies`, the `optionalDependencies` and the resolved `peerDependencies`; never the
   `devDependencies`), following `workspace:*` dependencies into the other workspace packages and
   resolving every name the way Bun does (nested override first, then the hoisted package);
3. it reads the license of every package from the npm registry (`/<name>/<version>`) and records it
   as one SPDX expression, with the integrity hash of the lock.

The result is `runner/opencode-bundled-licenses.json`, a reviewed snapshot that is committed. The
license check (app/src/ci/license-check) judges it offline against `license-policy.json`. The
closure is an UPPER BOUND: a superset of the modules that Bun's bundler embedded, because the
embedded set cannot be determined from the binary offline. A package that declares no license is
recorded as `NONE`, one that the registry does not know as `UNRESOLVED`; nothing is dropped quietly.

A human runs it, with the internet, when the pin changes:

    uv run python scripts/audit_opencode_bundle.py --fetch

Without `--fetch` it refuses to do anything: nothing in CI or at run time reaches the network.
"""

import argparse
import hashlib
import heapq
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, cast

RUNNER = Path(__file__).resolve().parents[1]
PIN_FILE = RUNNER / "opencode-pin.json"
SNAPSHOT_FILE = RUNNER / "opencode-bundled-licenses.json"
ROOT_WORKSPACE = "packages/opencode"
REGISTRY = "https://registry.npmjs.org/"
RAW_HOST = "https://raw.githubusercontent.com/"
GITHUB_HOST = "https://github.com/"
SCHEMA_VERSION = 1
ATTEMPTS = 4
BACKOFF_SECONDS = 1.0
RESPONSE_LIMIT = 32 * 1024 * 1024
VIA_RANK = {"dependency": 0, "optional": 1, "peer": 2}
EDGE_KINDS = (
    ("dependencies", "dependency"),
    ("optionalDependencies", "optional"),
    ("peerDependencies", "peer"),
)
REGISTRY_VERSION = re.compile(r"^\d+\.\d+\.\d+")

METHOD = (
    "Production dependency closure of the workspace packages/opencode in the bun.lock of the "
    "source commit: dependencies, optionalDependencies and peerDependencies that the lock "
    "resolves, workspace:* dependencies followed into the other workspace packages, "
    "devDependencies excluded. Names resolve the way Bun resolves them (nested override before "
    "the hoisted package). Licenses are read from the npm registry metadata of each exact version "
    "and written as one SPDX expression; the integrity is the hash from the lock."
)
CAVEAT = (
    "This list is an upper bound, a superset of what Bun's bundler embedded in the executable: the "
    "set of modules inside the binary cannot be determined offline from the binary, so every "
    "package that the release could have bundled is listed and judged. Packages marked "
    "via=optional or via=peer are the least likely to be inside the binary. NONE means that the "
    "registry metadata declares no license; UNRESOLVED means that the license could not be read."
)

Fetcher = Callable[[str], bytes]
Sleeper = Callable[[float], None]


class AuditError(Exception):
    """A stable code first, then the detail."""


class FetchError(Exception):
    def __init__(self, url: str, status: int | None) -> None:
        super().__init__(f"{url}: {status if status is not None else 'no response'}")
        self.url = url
        self.status = status


@dataclass(frozen=True)
class LockedPackage:
    name: str
    version: str
    integrity: str
    via: str


@dataclass(frozen=True)
class OtherSource:
    """A package that does not come from the npm registry (a git, https or file source)."""

    name: str
    spec: str
    via: str


@dataclass(frozen=True)
class Closure:
    packages: list[LockedPackage]
    unresolved: list[OtherSource]
    workspace_packages: list[str]
    absent: list[str]


def strip_trailing_commas(text: str) -> str:
    """bun.lock is JSONC: trailing commas, no comments. Drops them outside strings only."""
    out: list[str] = []
    in_string = False
    escaped = False
    pending: list[str] = []  # a comma and the whitespace after it, undecided
    for char in text:
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if pending:
            if char.isspace():
                pending.append(char)
                continue
            if char in "}]":
                out.extend(pending[1:])
            else:
                out.extend(pending)
            pending = []
        if char == ",":
            pending = [char]
            continue
        out.append(char)
        if char == '"':
            in_string = True
    out.extend(pending)
    return "".join(out)


def parse_lock(text: str) -> dict[str, Any]:
    try:
        lock = json.loads(strip_trailing_commas(text))
    except json.JSONDecodeError as error:
        raise AuditError(f"AUDIT_LOCK_UNREADABLE: bun.lock is not JSONC ({error})") from error
    if not isinstance(lock, dict):
        raise AuditError("AUDIT_LOCK_UNREADABLE: bun.lock is not an object")
    sections = cast(dict[str, Any], lock)
    for section in ("packages", "workspaces"):
        if not isinstance(sections.get(section), dict):
            raise AuditError(f"AUDIT_LOCK_UNREADABLE: bun.lock has no {section} section")
    return sections


def _key_parts(key: str) -> list[str]:
    parts: list[str] = []
    pieces = key.split("/")
    index = 0
    while index < len(pieces):
        if pieces[index].startswith("@") and index + 1 < len(pieces):
            parts.append(f"{pieces[index]}/{pieces[index + 1]}")
            index += 2
        else:
            parts.append(pieces[index])
            index += 1
    return parts


def _candidates(base: str, dependency: str) -> list[str]:
    """Keys that a dependency of the package at `base` may have, nearest first."""
    parts = _key_parts(base) if base else []
    keys = ["/".join([*parts[:end], dependency]) for end in range(len(parts), -1, -1)]
    return keys


def _split_id(package_id: str) -> tuple[str, str]:
    """`name@spec` where the name may start with `@scope/`."""
    at = package_id.find("@", 1)
    if at == -1:
        raise AuditError(f"AUDIT_LOCK_UNREADABLE: package id {package_id!r} has no version")
    return package_id[:at], package_id[at + 1 :]


def _mapping(value: Any) -> dict[str, Any]:
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def _edges(meta: Mapping[str, Any]) -> list[tuple[str, str]]:
    edges: list[tuple[str, str]] = []
    for field, via in EDGE_KINDS:
        edges.extend((name, via) for name in sorted(_mapping(meta.get(field))))
    return edges


def compute_closure(lock: Mapping[str, Any], root_workspace: str = ROOT_WORKSPACE) -> Closure:
    workspaces = _mapping(lock["workspaces"])
    packages = _mapping(lock["packages"])
    root = _mapping(workspaces.get(root_workspace))
    if not root:
        raise AuditError(f"AUDIT_WORKSPACE_UNKNOWN: {root_workspace} is not in bun.lock")

    best: dict[str, int] = {}
    found_workspaces: dict[str, str] = {}
    absent: dict[str, str] = {}
    queue: list[tuple[int, str]] = []  # (rank, key)

    def resolve(base: str, name: str) -> str | None:
        return next((key for key in _candidates(base, name) if key in packages), None)

    def expand(base: str, meta: Mapping[str, Any], rank: int, owner: str) -> None:
        for name, via in _edges(meta):
            edge_rank = max(rank, VIA_RANK[via])
            key = resolve(base, name)
            if key is None:
                if via == "dependency" and edge_rank == 0:
                    raise AuditError(
                        f"AUDIT_DEPENDENCY_NOT_IN_LOCK: {name} (a dependency of {owner}) "
                        "has no entry in bun.lock"
                    )
                absent[f"{name} ({via} of {owner})"] = name
                continue
            if edge_rank < best.get(key, len(VIA_RANK)):
                best[key] = edge_rank
                heapq.heappush(queue, (edge_rank, key))

    expand(str(root.get("name", root_workspace)), root, 0, str(root.get("name", root_workspace)))
    while queue:
        rank, key = heapq.heappop(queue)
        if best.get(key) != rank:
            continue
        entry = packages[key]
        package_id = str(entry[0])
        name, spec = _split_id(package_id)
        if spec.startswith("workspace:"):
            workspace = _mapping(workspaces.get(spec.removeprefix("workspace:")))
            workspace_name = str(workspace.get("name", name))
            found_workspaces[workspace_name] = spec
            expand(workspace_name, workspace, rank, workspace_name)
            continue
        meta = _mapping(entry[1] if len(entry) == 3 else entry[2] if len(entry) > 2 else {})
        expand(key, meta, rank, name)

    # The lock may hold one version under several keys (a nested copy next to the hoisted one);
    # the audit lists it once, with the strongest way it is reached.
    unique: dict[tuple[str, str], LockedPackage] = {}
    other: list[OtherSource] = []
    via_of = {rank: via for via, rank in VIA_RANK.items()}
    for key, rank in sorted(best.items()):
        entry = packages[key]
        name, spec = _split_id(str(entry[0]))
        if spec.startswith("workspace:"):
            continue
        is_registry = len(entry) == 4 and REGISTRY_VERSION.match(spec) is not None
        if not is_registry:
            other.append(OtherSource(name=name, spec=spec, via=via_of[rank]))
            continue
        known = unique.get((name, spec))
        if known is not None and VIA_RANK[known.via] <= rank:
            continue
        unique[(name, spec)] = LockedPackage(
            name=name, version=spec, integrity=str(entry[3]), via=via_of[rank]
        )
    registry_packages = sorted(unique.values(), key=lambda package: (package.name, package.version))
    other = sorted(set(other), key=lambda package: (package.name, package.spec))
    return Closure(
        packages=registry_packages,
        unresolved=other,
        workspace_packages=sorted(found_workspaces),
        absent=sorted(absent),
    )


def _declared(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        kind = cast(dict[str, Any], value).get("type")
        return kind.strip() or None if isinstance(kind, str) else None
    return None


def license_of(metadata: Mapping[str, Any]) -> str:
    """One SPDX expression from the registry metadata of a version: `license` (a string, or the
    legacy `{type, url}` object) or the legacy `licenses` list; `NONE` when nothing is declared."""
    declared = _declared(metadata.get("license"))
    if declared:
        return declared
    legacy = metadata.get("licenses")
    if isinstance(legacy, list):
        ids = [found for item in cast(list[Any], legacy) if (found := _declared(item)) is not None]
        if len(ids) == 1:
            return ids[0]
        if ids:
            return f"({' OR '.join(ids)})"
    return "NONE"


def fetch_with_retries(fetch: Fetcher, url: str, sleep: Sleeper) -> bytes | None:
    """The body, or None on a 404. Other failures are retried, then stop the audit."""
    last: FetchError | None = None
    for attempt in range(ATTEMPTS):
        try:
            return fetch(url)
        except FetchError as error:
            if error.status == 404:
                return None
            last = error
            if attempt + 1 < ATTEMPTS:
                sleep(BACKOFF_SECONDS * 2**attempt)
    raise AuditError(f"AUDIT_FETCH_FAILED: {last}")


def registry_url(name: str, version: str) -> str:
    return f"{REGISTRY}{urllib.parse.quote(name, safe='@')}/{urllib.parse.quote(version)}"


def raw_lock_url(repository: str, commit: str) -> str:
    if not repository.startswith(GITHUB_HOST):
        raise AuditError("AUDIT_PIN_INVALID: the repository of the pin is not on github.com")
    return f"{RAW_HOST}{repository.removeprefix(GITHUB_HOST).rstrip('/')}/{commit}/bun.lock"


def build_snapshot(
    *,
    commit: str,
    repository: str,
    version: str,
    fetch: Fetcher,
    generated_on: date,
    sleep: Sleeper = time.sleep,
    root_workspace: str = ROOT_WORKSPACE,
) -> dict[str, Any]:
    body = fetch_with_retries(fetch, raw_lock_url(repository, commit), sleep)
    if body is None:
        raise AuditError("AUDIT_LOCK_NOT_FOUND: there is no bun.lock at the pinned commit")
    closure = compute_closure(parse_lock(body.decode("utf-8")), root_workspace)

    entries: list[dict[str, Any]] = []
    unresolved: list[dict[str, str]] = []
    for package in closure.packages:
        document = fetch_with_retries(fetch, registry_url(package.name, package.version), sleep)
        license_id = "UNRESOLVED"
        if document is None:
            unresolved.append(
                {
                    "name": package.name,
                    "version": package.version,
                    "reason": "the registry has no such version (404)",
                }
            )
        else:
            try:
                metadata = json.loads(document)
            except json.JSONDecodeError as error:
                raise AuditError(
                    f"AUDIT_REGISTRY_UNREADABLE: {package.name}@{package.version}"
                ) from error
            license_id = license_of(_mapping(metadata))
        entries.append(
            {
                "name": package.name,
                "version": package.version,
                "license": license_id,
                "integrity": package.integrity,
                "via": package.via,
            }
        )
    for source in closure.unresolved:
        unresolved.append(
            {
                "name": source.name,
                "version": source.spec,
                "reason": "not from the npm registry, so no registry metadata to read",
            }
        )
        entries.append(
            {
                "name": source.name,
                "version": source.spec,
                "license": "UNRESOLVED",
                "integrity": "none",
                "via": source.via,
            }
        )
    entries.sort(key=lambda entry: (entry["name"], entry["version"]))
    unresolved.sort(key=lambda entry: (entry["name"], entry["version"]))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceRepository": repository,
        "sourceCommit": commit,
        "version": version,
        "lockFile": {"path": "bun.lock", "sha256": hashlib.sha256(body).hexdigest()},
        "rootWorkspace": root_workspace,
        "generatedOn": generated_on.isoformat(),
        "method": METHOD,
        "caveat": CAVEAT,
        "workspacePackages": closure.workspace_packages,
        "notInLock": closure.absent,
        "unresolved": unresolved,
        "packages": entries,
    }


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str):  # type: ignore[no-untyped-def,override]
        if not newurl.startswith("https://"):
            raise AuditError("AUDIT_FETCH_FAILED: redirected to something other than https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def https_fetch(url: str) -> bytes:
    """The one place that touches the network: https only, bounded, a short pause per request."""
    if not url.startswith("https://"):
        raise AuditError("AUDIT_FETCH_FAILED: not an https URL")
    time.sleep(0.05)
    opener = urllib.request.build_opener(_HttpsOnlyRedirects)
    request = urllib.request.Request(url, headers={"Accept": "application/json, text/plain"})
    try:
        with opener.open(request, timeout=60) as response:
            body: bytes = response.read(RESPONSE_LIMIT + 1)
    except urllib.error.HTTPError as error:
        raise FetchError(url, error.code) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise FetchError(url, None) from error
    if len(body) > RESPONSE_LIMIT:
        raise AuditError("AUDIT_FETCH_FAILED: a response is larger than the limit")
    return body


def main(
    argv: Sequence[str] | None = None,
    *,
    fetch: Fetcher | None = None,
    today: date | None = None,
    sleep: Sleeper = time.sleep,
) -> int:
    parser = argparse.ArgumentParser(description="Audit the packages inside the pinned OpenCode.")
    parser.add_argument("--fetch", action="store_true", help="allow the network (a human only)")
    parser.add_argument("--pin", type=Path, default=PIN_FILE)
    parser.add_argument("--output", type=Path, default=SNAPSHOT_FILE)
    args = parser.parse_args(argv)
    if not args.fetch:
        print(
            "audit_opencode_bundle: refusing to reach the network without --fetch "
            "(this script is run by a person when the OpenCode pin changes)",
            file=sys.stderr,
        )
        return 2
    try:
        pin = _mapping(json.loads(args.pin.read_text(encoding="utf-8")))
        commit, repository, version = (
            str(pin.get(field, "")) for field in ("commit", "repository", "version")
        )
        if not (re.fullmatch(r"[0-9a-f]{40}", commit) and repository and version):
            raise AuditError(
                "AUDIT_PIN_INVALID: the pin needs repository, version and a 40 digit commit"
            )
        snapshot = build_snapshot(
            commit=commit,
            repository=repository,
            version=version,
            fetch=fetch or https_fetch,
            generated_on=today or date.today(),
            sleep=sleep,
        )
    except (AuditError, OSError, json.JSONDecodeError) as error:
        print(f"audit_opencode_bundle: {error}", file=sys.stderr)
        return 1
    args.output.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"{len(snapshot['packages'])} packages written to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
