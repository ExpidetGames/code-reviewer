# SPDX-License-Identifier: Apache-2.0

"""Pins down the capability probe contract (#331) from the runner's side.

The `probe` entry mode prints a verdict (`ProbeVerdict`); the Dispatcher reads it and keeps only the
stable reasons of the closed list in `contracts/probe-verdict.v1.json`. The runner is the writer,
so what it can write must be valid under the file, and its list of reasons must be that list.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from code_reviewer_runner.dynamic_review.self_check import SelfCheckReason
from code_reviewer_runner.verdict import Verdict

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
Document = dict[str, Any]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


_PROBE: Document = _load(CONTRACTS / "probe-verdict.v1.json")
_RUNNER_API: Document = _load(CONTRACTS / "runner-api.v1.json")
_REGISTRY: Registry[Any] = (
    Registry()
    .with_resource(_PROBE["$id"], Resource.from_contents(_PROBE))
    .with_resource(_RUNNER_API["$id"], Resource.from_contents(_RUNNER_API))
)


def _accepts(definition: str, document: Any) -> bool:
    validator = Draft202012Validator(
        {"$ref": f"{_PROBE['$id']}#/$defs/{definition}"}, registry=_REGISTRY
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


@pytest.mark.contract
@pytest.mark.parametrize("definition", ["ProbeVerdict", "ProbeReport"])
def test_every_example_is_valid(definition: str) -> None:
    # #331-T08
    example = _load(CONTRACTS / "examples" / "probe-verdict" / f"{definition}.json")

    assert _accepts(definition, example)


@pytest.mark.contract
def test_the_reasons_of_the_contract_are_the_self_check_reasons() -> None:
    # #331-T08
    listed = set(_PROBE["$defs"]["ProbeReason"]["enum"])

    assert listed == {reason.value for reason in SelfCheckReason}


@pytest.mark.contract
@pytest.mark.parametrize(
    "verdict",
    [
        Verdict(("pr-agent", "opencode")),
        Verdict(("pr-agent",), (SelfCheckReason.ROOT_FILESYSTEM_WRITABLE.value,)),
        Verdict(("pr-agent",), tuple(reason.value for reason in SelfCheckReason)),
    ],
)
def test_what_the_probe_prints_is_a_valid_verdict(verdict: Verdict) -> None:
    # #331-T08
    assert _accepts("ProbeVerdict", json.loads(verdict.to_json()))


@pytest.mark.contract
@pytest.mark.parametrize(
    "document",
    [
        {"version": 1, "engines": ["pr-agent"], "reasons": ["ghp_0123456789abcdef0123456789abcdef0123"]},
        {"version": 1, "engines": ["pr-agent"], "reasons": [], "path": "/run/secret"},
        {"version": 1, "engines": ["not-an-engine"], "reasons": []},
        {"version": 2, "engines": ["pr-agent"], "reasons": []},
    ],
)
def test_the_verdict_is_closed(document: Document) -> None:
    # #331-T08
    assert not _accepts("ProbeVerdict", document)
