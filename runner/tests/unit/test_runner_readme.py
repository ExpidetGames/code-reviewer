# SPDX-License-Identifier: Apache-2.0

"""Pins down that the error codes documented in the runner README are exactly the codes the runner
can report, so the documentation cannot drift from the single definition in `ErrorCode`."""

import re
from pathlib import Path

from code_reviewer_runner.result import ErrorCode

README = Path(__file__).parents[2] / "README.md"


def documented_codes() -> set[str]:
    section = README.read_text().split("## Error codes", 1)[1].split("\n## ", 1)[0]
    return set(re.findall(r"^\| `([a-z_]+)` \|", section, flags=re.MULTILINE))


def test_the_readme_lists_every_error_code_and_nothing_else() -> None:
    assert documented_codes() == {code.value for code in ErrorCode}


# #511-T29: the Anthropic section names every module and every test file of the provider, and each
# file it names exists.
def test_the_readme_describes_every_anthropic_file_and_test_and_names_no_missing_one() -> None:
    package = Path(__file__).parents[2] / "src" / "code_reviewer_runner"
    tests = Path(__file__).parents[1]
    section = README.read_text().split("## Anthropic (Claude API", 1)[1].split("\n## ", 1)[0]

    existing = {path.name for path in package.glob("anthropic*.py")}
    existing |= {path.name for path in tests.rglob("test_*anthropic*.py")}
    named = set(re.findall(r"(?<!\w)((?:test_)?\w*anthropic\w*\.py)\b", section))
    assert existing and existing == named


def test_the_codes_the_project_lead_named_exist() -> None:
    named = {
        "invalid_job",
        "invalid_command",
        "pr_agent_version_mismatch",
        "pr_not_found",
        "git_unavailable",
        "git_rate_limit",
        "llm_rate_limit",
        "llm_timeout",
        "llm_output_invalid",
        "review_not_published",
        "timeout",
        "unknown",
    }

    assert named <= {code.value for code in ErrorCode}
