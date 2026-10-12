# SPDX-License-Identifier: Apache-2.0

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

from code_reviewer_runner import job as runner_job

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
        pytest.param(_foreign_environment_variable, id="variable outside the review tool"),
        pytest.param(_lease_expiry_not_a_timestamp, id="lease expiry not a timestamp"),
    ],
)
def test_a_claim_response_that_breaks_a_rule_is_refused(mutate: Callable[[Document], None]) -> None:
    claim = copy.deepcopy(_example("ClaimResponse"))
    mutate(claim)

    assert not _accepts("ClaimResponse", claim)


# #203-T13: only /review is accepted, and it takes no arguments.
def test_only_the_review_command_and_no_arguments_are_accepted() -> None:
    claim = copy.deepcopy(_example("ClaimResponse"))
    claim["job"]["input"]["command"] = "ask"
    assert not _accepts("ClaimResponse", claim)

    claim["job"]["input"]["command"] = "review"
    claim["job"]["input"]["args"] = ["Why is this lock needed?"]
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


def test_every_error_code_of_the_runner_is_in_the_contract() -> None:
    from code_reviewer_runner.result import ErrorCode

    schema: Document = _load(SCHEMA_PATH)
    listed: list[str] = schema["$defs"]["KnownRunnerErrorCode"]["enum"]

    assert {code.value for code in ErrorCode} <= set(listed)


def test_a_failed_result_may_carry_the_link_of_a_review_that_was_posted_but_shortened() -> None:
    result = _example("CompleteRequest")["result"]
    result.update(
        ok=False,
        errorCode="review_state_truncated",
        commentUrl="https://github.com/octo/repo/pull/7#issuecomment-1",
    )

    assert _accepts("RunnerResult", result)


def test_a_complete_response_may_say_the_job_was_given_back_after_a_shutdown() -> None:
    response = _example("CompleteResponse")
    response["job"]["status"] = "queued"
    assert _accepts("CompleteResponse", response)

    response["job"]["status"] = "cancelled"
    assert not _accepts("CompleteResponse", response)


# CR-29 alignment: the contract and the runner state the same rules twice, so both are read from
# their sources and compared.
def test_the_job_env_key_pattern_of_the_runner_equals_the_one_of_the_contract() -> None:
    schema: Document = _load(SCHEMA_PATH)
    contract_pattern: str = schema["$defs"]["JobEnv"]["propertyNames"]["pattern"]

    # The contract anchors the pattern, the runner uses fullmatch: the same rule written twice.
    assert contract_pattern == f"^{runner_job._ENV_KEY.pattern}$"  # pyright: ignore[reportPrivateUsage]


@pytest.mark.parametrize(
    "key",
    [
        "PR_REVIEWER__EXTRA_INSTRUCTIONS",
        "PR_DESCRIPTION__ADD_ORIGINAL_USER_DESCRIPTION",
        "PR_CODE_SUGGESTIONS__NUM_CODE_SUGGESTIONS",
        "PR_QUESTIONS__ENABLE_HELP_TEXT",
        "PR_REVIEWER__NUM_MAX_FINDINGS",
        "GITHUB__USER_TOKEN",
        "CONFIG__MODEL",
        "PR_REVIEWER__",
        "PR_REVIEWER__EXTRA__NESTED",
        "PR_REVIEWER__EXTRA_",
        "pr_reviewer__extra_instructions",
        "PR_OTHER__EXTRA_INSTRUCTIONS",
    ],
)
def test_the_runner_and_the_contract_give_the_same_verdict_on_a_job_env_key(key: str) -> None:
    claim = _example("ClaimResponse")
    claim["job"]["input"]["env"] = {key: "x"}
    contract_accepts = _accepts("ClaimResponse", claim)

    try:
        runner_job.parse_job(json.dumps(claim["job"]["input"]))
        runner_accepts = True
    except runner_job.JobError:
        runner_accepts = False

    assert runner_accepts == contract_accepts


def test_the_runner_accepts_the_fallback_models_the_way_the_contract_defines_them() -> None:
    schema: Document = _load(SCHEMA_PATH)
    definition = schema["$defs"]["RunnerJobInput"]["properties"]["llm"]["properties"]
    max_items: int = definition["fallbackModels"]["maxItems"]
    models = [f"vendor/fallback-{number}" for number in range(max_items)]
    claim = _example("ClaimResponse")
    claim["job"]["input"]["llm"]["fallbackModels"] = models
    assert _accepts("ClaimResponse", claim)

    parsed = runner_job.parse_job(json.dumps(claim["job"]["input"]))

    assert parsed.llm.fallback_models == tuple(models)
    assert max_items == runner_job.MAX_FALLBACK_MODELS


def test_the_runner_and_the_contract_both_refuse_more_fallback_models_than_allowed() -> None:
    schema: Document = _load(SCHEMA_PATH)
    max_items: int = schema["$defs"]["RunnerJobInput"]["properties"]["llm"]["properties"][
        "fallbackModels"
    ]["maxItems"]
    claim = _example("ClaimResponse")
    claim["job"]["input"]["llm"]["fallbackModels"] = [
        f"vendor/fallback-{number}" for number in range(max_items + 1)
    ]

    assert not _accepts("ClaimResponse", claim)
    with pytest.raises(runner_job.JobError):
        runner_job.parse_job(json.dumps(claim["job"]["input"]))
