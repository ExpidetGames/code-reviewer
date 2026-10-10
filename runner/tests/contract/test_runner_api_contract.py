"""Pins down the runner API format of contracts/runner-api.v1.json from the runner's side.

The app checks its real answers against the same file (app/integration-tests/compatibility), so a
change to the format has to change both sides. Here the file itself is checked: the examples in
contracts/examples are valid, and the rules the runner relies on (a closed job input, the error
code rules of a result, tolerance for fields it does not know) hold.
"""

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
SCHEMA_PATH = CONTRACTS / "runner-api.v1.json"
EXAMPLES = CONTRACTS / "examples"

# The definitions that describe a whole request or response body. Each has one example file.
BODIES = (
    "ClaimResponse",
    "HeartbeatRequest",
    "HeartbeatResponse",
    "CompleteRequest",
    "CompleteResponse",
    "ErrorResponse",
)

Document = dict[str, Any]


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _validator(definition: str) -> Draft202012Validator:
    schema: Document = _load(SCHEMA_PATH)
    return Draft202012Validator(
        {"$schema": schema["$schema"], "$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]}
    )


def _accepts(definition: str, document: Document) -> bool:
    # The overloads of is_valid are only partly typed in jsonschema.
    return bool(_validator(definition).is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def _example(definition: str) -> Document:
    return _load(EXAMPLES / f"{definition}.json")


def test_the_contract_file_is_a_valid_schema_of_version_one() -> None:
    schema: Document = _load(SCHEMA_PATH)

    Draft202012Validator.check_schema(schema)
    assert schema["version"] == 1
    assert schema["$defs"]["ClaimResponse"]["properties"]["version"] == {"const": 1}


# CR-28-T01
@pytest.mark.parametrize("definition", BODIES)
def test_the_example_of_every_body_is_valid(definition: str) -> None:
    assert _accepts(definition, _example(definition))


def test_there_is_exactly_one_example_per_body() -> None:
    assert sorted(path.stem for path in EXAMPLES.glob("*.json")) == sorted(BODIES)


# CR-28-T02
def test_a_claim_response_with_fields_the_runner_does_not_know_is_still_valid() -> None:
    claim = _example("ClaimResponse")
    claim["somethingNew"] = {"nested": True}
    claim["job"]["priority"] = 5

    assert _accepts("ClaimResponse", claim)


def test_the_job_input_is_closed_because_the_runner_refuses_unknown_fields() -> None:
    claim = _example("ClaimResponse")
    claim["job"]["input"]["git"]["expiresAt"] = "2026-10-10T13:00:00.000Z"

    assert not _accepts("ClaimResponse", claim)


def _without_git_token(claim: Document) -> None:
    del claim["job"]["input"]["git"]["token"]


def _without_llm_key(claim: Document) -> None:
    del claim["job"]["input"]["llm"]["apiKey"]


def _without_lease_token(claim: Document) -> None:
    del claim["job"]["leaseToken"]


def _without_version(claim: Document) -> None:
    del claim["version"]


def _another_version(claim: Document) -> None:
    claim["version"] = 2


def _unsupported_platform(claim: Document) -> None:
    claim["job"]["input"]["git"]["provider"] = "gitlab"


def _command_not_allowed(claim: Document) -> None:
    claim["job"]["input"]["command"] = "deploy"


def _arguments_for_a_review(claim: Document) -> None:
    claim["job"]["input"]["args"] = ["why?"]


def _foreign_environment_variable(claim: Document) -> None:
    claim["job"]["input"]["env"]["GITHUB__USER_TOKEN"] = "x"


def _lease_expiry_not_a_timestamp(claim: Document) -> None:
    claim["job"]["leaseExpiresAt"] = "tomorrow"


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(_without_git_token, id="no git token"),
        pytest.param(_without_llm_key, id="no llm key"),
        pytest.param(_without_lease_token, id="no lease token"),
        pytest.param(_without_version, id="no version"),
        pytest.param(_another_version, id="another version"),
        pytest.param(_unsupported_platform, id="unsupported platform"),
        pytest.param(_command_not_allowed, id="command not allowed"),
        pytest.param(_arguments_for_a_review, id="arguments for a review"),
        pytest.param(_foreign_environment_variable, id="variable outside the four tools"),
        pytest.param(_lease_expiry_not_a_timestamp, id="lease expiry not a timestamp"),
    ],
)
def test_a_claim_response_that_breaks_a_rule_is_refused(mutate: Callable[[Document], None]) -> None:
    claim = copy.deepcopy(_example("ClaimResponse"))
    mutate(claim)

    assert not _accepts("ClaimResponse", claim)


def test_an_ask_job_needs_exactly_its_question() -> None:
    claim = _example("ClaimResponse")
    claim["job"]["input"]["command"] = "ask"
    assert not _accepts("ClaimResponse", claim)

    claim["job"]["input"]["args"] = ["Why is this lock needed?"]
    assert _accepts("ClaimResponse", claim)

    claim["job"]["input"]["args"] = ["one", "two"]
    assert not _accepts("ClaimResponse", claim)


# CR-28-T03
def test_a_failed_result_needs_an_error_code_and_a_good_one_must_not_have_it() -> None:
    complete = _example("CompleteRequest")
    complete["result"]["errorCode"] = "timeout"
    assert not _accepts("CompleteRequest", complete)

    complete["result"]["ok"] = False
    assert _accepts("CompleteRequest", complete)

    complete["result"]["errorCode"] = None
    assert not _accepts("CompleteRequest", complete)


def test_every_error_of_the_api_has_a_stable_code_and_a_message() -> None:
    error = _example("ErrorResponse")
    assert _accepts("ErrorResponse", error)

    error["error"]["code"] = "something went wrong"
    assert not _accepts("ErrorResponse", error)

    del error["error"]["code"]
    assert not _accepts("ErrorResponse", error)


def test_the_error_codes_the_runner_reports_are_listed_once() -> None:
    schema: Document = _load(SCHEMA_PATH)
    codes: list[str] = schema["$defs"]["KnownRunnerErrorCode"]["enum"]

    assert len(codes) == len(set(codes))
    assert {"timeout", "llm_auth", "git_rate_limit", "runner_shutdown", "unknown"} <= set(codes)
