# SPDX-License-Identifier: Apache-2.0

"""#202-T06: the audit of the third-party packages inside the pinned OpenCode binary.

The OpenCode release is a Bun-compiled executable: its bundled JavaScript dependencies are not
visible to the npm or uv collectors of the license check. `scripts/audit_opencode_bundle.py` reads
the upstream `bun.lock` at the pinned commit, computes the production dependency closure of the
`packages/opencode` workspace and writes the reviewed snapshot
`runner/opencode-bundled-licenses.json` that `make check-licenses` judges offline. Nothing here
touches the network: the fetcher is injected.
"""

import hashlib
import importlib.util
import json
import re
import sys
from datetime import date
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

RUNNER = Path(__file__).parents[2]
SCRIPT = RUNNER / "scripts" / "audit_opencode_bundle.py"
PIN = RUNNER / "opencode-pin.json"
SNAPSHOT = RUNNER / "opencode-bundled-licenses.json"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("audit_opencode_bundle", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["audit_opencode_bundle"] = module
    spec.loader.exec_module(module)
    return module


audit = load_script()

COMMIT = "733b2c627e5aec39cb33cc22373bdce33053ef2c"

# A miniature bun.lock (JSONC: trailing commas). `opencode` is the root workspace; `@scope/core` is
# a workspace package it uses; `opencode/semver` is a nested override of `semver`.
LOCK = """{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root", "dependencies": { "root-only": "1.0.0", }, },
    "packages/opencode": {
      "name": "opencode",
      "version": "1.0.0",
      "dependencies": {
        "alpha": "1.0.0",
        "semver": "^7.0.0",
        "@scope/core": "workspace:*",
        "gone-optional": "1.0.0",
      },
      "devDependencies": { "dev-tool": "1.0.0", },
    },
    "packages/core": {
      "name": "@scope/core",
      "dependencies": { "core-dep": "2.0.0", },
      "devDependencies": { "core-dev": "1.0.0", },
    },
    "packages/unrelated": { "name": "unrelated", "dependencies": { "unrelated-dep": "1.0.0", }, },
  },
  "packages": {
    "root-only": ["root-only@1.0.0", "", {}, "sha512-root"],
    "alpha": ["alpha@1.0.0", "", {
      "dependencies": { "beta": "^1.0.0", "semver": "^6.0.0", },
      "optionalDependencies": { "opt": "1.0.0", "opt-absent": "1.0.0", },
      "peerDependencies": { "peer": "*", "peer-absent": "*", },
    }, "sha512-alpha"],
    "beta": ["beta@1.2.0", "", { "dependencies": { "alpha": "^1.0.0", } }, "sha512-beta"],
    "opt": ["opt@1.0.0", "", {}, "sha512-opt"],
    "peer": ["peer@3.0.0", "", {}, "sha512-peer"],
    "semver": ["semver@6.3.1", "", {}, "sha512-semver6"],
    "opencode/semver": ["semver@7.7.4", "", {}, "sha512-semver7"],
    "alpha/semver": ["semver@6.9.9", "", {}, "sha512-alpha-semver"],
    "dev-tool": ["dev-tool@1.0.0", "", {}, "sha512-dev"],
    "@scope/core": ["@scope/core@workspace:packages/core"],
    "core-dep": ["core-dep@2.0.0", "", {
      "dependencies": { "@scope/deep": "1.0.0", },
    }, "sha512-core-dep"],
    "@scope/deep": ["@scope/deep@1.0.0", "", {}, "sha512-deep"],
    "core-dev": ["core-dev@1.0.0", "", {}, "sha512-core-dev"],
    "unrelated-dep": ["unrelated-dep@1.0.0", "", {}, "sha512-unrelated"],
    "gone-optional": ["gone-optional@1.0.0", "", {}, "sha512-gone"],
  }
}
"""

REGISTRY = "https://registry.npmjs.org/"


def no_sleep(_seconds: float) -> None:
    """The retries of the script wait; the tests do not."""


def registry_document(license_value: Any = "MIT") -> bytes:
    return json.dumps({"license": license_value}).encode()


class FakeNetwork:
    """Answers registry URLs from a table; records every URL asked for."""

    def __init__(self, documents: dict[str, bytes], lock_text: str = LOCK) -> None:
        self.documents = documents
        self.lock_text = lock_text
        self.requested: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.requested.append(url)
        if url.endswith("/bun.lock"):
            return self.lock_text.encode()
        if url in self.documents:
            return self.documents[url]
        raise audit.FetchError(url, 404)


def package_names(closure: Any) -> list[str]:
    return sorted(f"{p.name}@{p.version}" for p in closure.packages)


def test_trailing_commas_are_dropped_but_never_inside_strings() -> None:
    text = '{"a": [1, 2, ], "b": "x,}", "c": {"d": "y,]", },}'

    assert json.loads(audit.strip_trailing_commas(text)) == {
        "a": [1, 2],
        "b": "x,}",
        "c": {"d": "y,]"},
    }


def test_the_closure_follows_production_dependencies_and_leaves_devDependencies_out() -> None:
    closure = audit.compute_closure(audit.parse_lock(LOCK), "packages/opencode")

    names = package_names(closure)
    assert "alpha@1.0.0" in names
    assert "beta@1.2.0" in names  # transitive; the cycle beta -> alpha ends
    assert "dev-tool@1.0.0" not in names
    assert "root-only@1.0.0" not in names
    assert "unrelated-dep@1.0.0" not in names


def test_a_nested_override_wins_over_the_hoisted_version() -> None:
    closure = audit.compute_closure(audit.parse_lock(LOCK), "packages/opencode")

    versions = {(p.name, p.version) for p in closure.packages}
    # opencode asks for semver: opencode/semver (7.7.4); alpha asks for semver: alpha/semver
    # (6.9.9); the hoisted 6.3.1 is nobody's choice here and must not appear.
    assert ("semver", "7.7.4") in versions
    assert ("semver", "6.9.9") in versions
    assert ("semver", "6.3.1") not in versions


def test_one_version_that_the_lock_holds_under_several_keys_is_listed_once() -> None:
    lock = LOCK.replace(
        '"beta": ["beta@1.2.0", "", { "dependencies": { "alpha": "^1.0.0", } }, "sha512-beta"],',
        '"beta": ["beta@1.2.0", "", { "dependencies": { "alpha": "^1.0.0", "semver": "^6.0.0", } },'
        ' "sha512-beta"],\n    "beta/semver": ["semver@6.9.9", "", {}, "sha512-alpha-semver"],',
    )

    closure = audit.compute_closure(audit.parse_lock(lock), "packages/opencode")

    assert [p.version for p in closure.packages if p.name == "semver"] == ["6.9.9", "7.7.4"]


def test_workspace_dependencies_are_followed_into_the_other_workspace() -> None:
    closure = audit.compute_closure(audit.parse_lock(LOCK), "packages/opencode")

    names = package_names(closure)
    assert closure.workspace_packages == ["@scope/core"]
    assert "core-dep@2.0.0" in names
    assert "@scope/deep@1.0.0" in names
    assert "core-dev@1.0.0" not in names
    assert not any(name.startswith("@scope/core@") for name in names)  # first party, not a package


def test_optional_and_peer_dependencies_that_the_lock_resolves_are_included_and_marked() -> None:
    closure = audit.compute_closure(audit.parse_lock(LOCK), "packages/opencode")

    via = {p.name: p.via for p in closure.packages}
    assert via["alpha"] == "dependency"
    assert via["opt"] == "optional"
    assert via["peer"] == "peer"
    assert closure.absent == ["opt-absent (optional of alpha)", "peer-absent (peer of alpha)"]


def test_a_missing_hard_dependency_stops_the_audit() -> None:
    lock = LOCK.replace('"gone-optional": ["gone-optional@1.0.0", "", {}, "sha512-gone"],', "")

    with pytest.raises(audit.AuditError, match=r"AUDIT_DEPENDENCY_NOT_IN_LOCK.*gone-optional"):
        audit.compute_closure(audit.parse_lock(lock), "packages/opencode")


def test_an_unknown_workspace_is_refused() -> None:
    with pytest.raises(audit.AuditError, match="AUDIT_WORKSPACE_UNKNOWN"):
        audit.compute_closure(audit.parse_lock(LOCK), "packages/nope")


def test_a_package_that_is_not_from_the_registry_is_listed_as_unresolved() -> None:
    lock = LOCK.replace(
        '"beta": ["beta@1.2.0", "", { "dependencies": { "alpha": "^1.0.0", } }, "sha512-beta"],',
        '"beta": ["beta@github:org/beta#abc1234", { "dependencies": {} }, "org-beta-abc1234"],',
    )

    closure = audit.compute_closure(audit.parse_lock(lock), "packages/opencode")

    assert [(p.name, p.spec) for p in closure.unresolved] == [("beta", "github:org/beta#abc1234")]
    assert "beta@1.2.0" not in package_names(closure)


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [
        ({"license": "MIT"}, "MIT"),
        ({"license": " Apache-2.0 "}, "Apache-2.0"),
        ({"license": {"type": "MIT", "url": "https://x.invalid"}}, "MIT"),
        ({"licenses": [{"type": "MIT"}, {"type": "Apache-2.0"}]}, "(MIT OR Apache-2.0)"),
        ({"licenses": [{"type": "ISC"}]}, "ISC"),
        ({"license": "(MIT OR Apache-2.0)"}, "(MIT OR Apache-2.0)"),
        ({"license": "SEE LICENSE IN LICENSE.md"}, "SEE LICENSE IN LICENSE.md"),
        ({"license": "UNLICENSED"}, "UNLICENSED"),
        ({"license": ""}, "NONE"),
        ({"license": {}}, "NONE"),
        ({}, "NONE"),
    ],
)
def test_the_license_of_registry_metadata_becomes_one_spdx_expression(
    metadata: dict[str, Any], expected: str
) -> None:
    assert audit.license_of(metadata) == expected


def snapshot_for(network: FakeNetwork, *, sleep: Any = no_sleep) -> dict[str, Any]:
    return audit.build_snapshot(
        commit=COMMIT,
        repository="https://github.com/anomalyco/opencode",
        version="1.19.0",
        fetch=network,
        generated_on=date(2026, 10, 14),
        sleep=sleep,
    )


def lock_network(**overrides: bytes) -> FakeNetwork:
    documents = {
        f"{REGISTRY}{name}/{version}": registry_document()
        for name, version in [
            ("alpha", "1.0.0"),
            ("beta", "1.2.0"),
            ("opt", "1.0.0"),
            ("peer", "3.0.0"),
            ("semver", "7.7.4"),
            ("semver", "6.9.9"),
            ("core-dep", "2.0.0"),
            ("gone-optional", "1.0.0"),
        ]
    }
    documents[f"{REGISTRY}@scope%2Fdeep/1.0.0"] = registry_document({"type": "ISC"})
    documents.update({f"{REGISTRY}{key}": value for key, value in overrides.items()})
    return FakeNetwork(documents)


def test_the_snapshot_carries_the_header_the_reviewers_need() -> None:
    snapshot = snapshot_for(lock_network())

    assert snapshot["schemaVersion"] == 1
    assert snapshot["sourceCommit"] == COMMIT
    assert snapshot["sourceRepository"] == "https://github.com/anomalyco/opencode"
    assert snapshot["version"] == "1.19.0"
    assert snapshot["lockFile"] == {
        "path": "bun.lock",
        "sha256": hashlib.sha256(LOCK.encode()).hexdigest(),
    }
    assert snapshot["rootWorkspace"] == "packages/opencode"
    assert snapshot["generatedOn"] == "2026-10-14"
    assert "upper bound" in snapshot["caveat"]
    assert "superset" in snapshot["caveat"]
    assert snapshot["method"]
    assert snapshot["workspacePackages"] == ["@scope/core"]


def test_the_snapshot_lists_name_version_license_integrity_sorted_and_unique() -> None:
    snapshot = snapshot_for(lock_network())

    packages = snapshot["packages"]
    keys = [(p["name"], p["version"]) for p in packages]
    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)
    deep = next(p for p in packages if p["name"] == "@scope/deep")
    assert deep == {
        "name": "@scope/deep",
        "version": "1.0.0",
        "license": "ISC",
        "integrity": "sha512-deep",
        "via": "dependency",
    }


def test_a_package_the_registry_does_not_know_is_recorded_as_unresolved_not_dropped() -> None:
    network = lock_network()
    del network.documents[f"{REGISTRY}opt/1.0.0"]

    snapshot = snapshot_for(network)

    opt = next(p for p in snapshot["packages"] if p["name"] == "opt")
    assert opt["license"] == "UNRESOLVED"
    assert snapshot["unresolved"] == [
        {"name": "opt", "version": "1.0.0", "reason": "the registry has no such version (404)"}
    ]


def test_a_package_that_declares_no_license_is_recorded_as_none() -> None:
    snapshot = snapshot_for(lock_network(**{"peer/3.0.0": json.dumps({"name": "peer"}).encode()}))

    peer = next(p for p in snapshot["packages"] if p["name"] == "peer")
    assert peer["license"] == "NONE"


def test_a_failing_registry_is_retried_and_then_stops_the_audit() -> None:
    network = lock_network()
    original = network.__call__
    attempts = {"count": 0}
    slept: list[float] = []

    def flaky(url: str) -> bytes:
        if url == f"{REGISTRY}alpha/1.0.0":
            attempts["count"] += 1
            if attempts["count"] < 3:
                raise audit.FetchError(url, 503)
        return original(url)

    snapshot = audit.build_snapshot(
        commit=COMMIT,
        repository="https://github.com/anomalyco/opencode",
        version="1",
        fetch=flaky,
        generated_on=date(2026, 10, 14),
        sleep=slept.append,
    )

    assert next(p for p in snapshot["packages"] if p["name"] == "alpha")["license"] == "MIT"
    assert attempts["count"] == 3
    assert len(slept) == 2

    def down(url: str) -> bytes:
        if url.endswith("/bun.lock"):
            return LOCK.encode()
        raise audit.FetchError(url, 500)

    with pytest.raises(audit.AuditError, match="AUDIT_FETCH_FAILED"):
        audit.build_snapshot(
            commit=COMMIT,
            repository="https://github.com/anomalyco/opencode",
            version="1",
            fetch=down,
            generated_on=date(2026, 10, 14),
            sleep=no_sleep,
        )


def test_the_script_never_goes_to_the_network_without_fetch(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    network = lock_network()
    output = tmp_path / "out.json"

    code = audit.main(["--output", str(output)], fetch=network)

    assert code == 2
    assert "--fetch" in capsys.readouterr().err
    assert network.requested == []
    assert not output.exists()


def test_the_script_writes_the_snapshot_for_the_pinned_commit_when_asked_to_fetch(
    tmp_path: Path,
) -> None:
    network = lock_network()
    output = tmp_path / "out.json"
    pin = tmp_path / "pin.json"
    pin.write_text(
        json.dumps(
            {
                "repository": "https://github.com/anomalyco/opencode",
                "version": "1.19.0",
                "commit": COMMIT,
            }
        )
    )

    code = audit.main(
        ["--fetch", "--pin", str(pin), "--output", str(output)],
        fetch=network,
        today=date(2026, 10, 14),
        sleep=no_sleep,
    )

    assert code == 0
    written = json.loads(output.read_text())
    assert written["sourceCommit"] == COMMIT
    assert output.read_text().endswith("}\n")
    assert network.requested[0] == (
        f"https://raw.githubusercontent.com/anomalyco/opencode/{COMMIT}/bun.lock"
    )
    assert all(
        url.startswith(("https://raw.githubusercontent.com/", REGISTRY))
        for url in network.requested
    )


def test_the_script_is_stdlib_only() -> None:
    imports = set(re.findall(r"^(?:import|from) (\w+)", SCRIPT.read_text(), re.MULTILINE))

    allowed = set(sys.stdlib_module_names) | {"__future__"}
    assert imports <= allowed, imports - allowed


# The committed snapshot, which `make check-licenses` reads, is judged by the TypeScript check; the
# facts below only make sure that it is the snapshot of this pin and that it keeps its caveat.
def test_the_committed_snapshot_belongs_to_the_pin_and_keeps_its_caveat() -> None:
    pin = json.loads(PIN.read_text())
    snapshot = json.loads(SNAPSHOT.read_text())

    assert snapshot["sourceCommit"] == pin["commit"]
    assert snapshot["version"] == pin["version"]
    assert re.fullmatch(r"[0-9a-f]{64}", snapshot["lockFile"]["sha256"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", snapshot["generatedOn"])
    assert "upper bound" in snapshot["caveat"]
    keys = [(p["name"], p["version"]) for p in snapshot["packages"]]
    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)
    assert len(keys) > 100
    for package in snapshot["packages"]:
        assert package["license"], package
        assert package["integrity"].startswith(("sha512-", "sha1-", "sha256-")), package
        assert package["via"] in {"dependency", "optional", "peer"}, package
