# SPDX-License-Identifier: Apache-2.0
"""Checkout policy is applied to names and modes before any blob is read."""

import pytest

from code_reviewer_runner.dynamic_review.content_policy import content_text, omission_reason
from code_reviewer_runner.dynamic_review.limits import CheckoutError, Limits
from code_reviewer_runner.dynamic_review.paths import validate_path
from code_reviewer_runner.redaction import Redactor


# #196-T02
@pytest.mark.parametrize(
    "path",
    [
        "/etc/passwd",
        "../x",
        "a/../x",
        "a//b",
        "a/./b",
        "C:/x",
        "C:x",
        "\\\\server\\share",
        "a\\b",
        "a\x00b",
        "a\nb",
        "a/.git/config",
        ".GIT/config",
        "a/CON",
        "a/x.",
    ],
)
def test_unsafe_paths_are_refused(path: str) -> None:
    with pytest.raises(CheckoutError):
        validate_path(path, Limits())


# #196-T02
@pytest.mark.parametrize("path", ["abcde", "a/b/c"])
def test_path_length_and_depth_are_bounded(path: str) -> None:
    with pytest.raises(CheckoutError):
        validate_path(path, Limits(path_bytes=4, path_depth=2))


# #196-T10
@pytest.mark.parametrize("prefix", ["", "a/", "a/b/"])
@pytest.mark.parametrize(
    "name",
    [
        "opencode.json",
        "opencode.jsonc",
        "tui.json",
        "tui.jsonc",
        *[
            f".opencode/{x}/payload.js"
            for x in (
                "agent",
                "agents",
                "mode",
                "modes",
                "command",
                "commands",
                "plugin",
                "plugins",
                "tool",
                "tools",
                "skill",
                "skills",
                "theme",
                "themes",
            )
        ],
        ".opencode/package.json",
        ".opencode/node_modules/payload.js",
        ".claude/skills/x/SKILL.md",
        ".agents/skills/x/SKILL.md",
    ],
)
def test_engine_discovery_inputs_are_omitted_at_every_depth(prefix: str, name: str) -> None:
    assert omission_reason(prefix + name, "100644") == "engine_discovery"


# #196-T05
@pytest.mark.parametrize(
    "path",
    [
        ".env",
        ".env.local",
        "a/.env.production",
        "a/key.pem",
        "id_rsa",
        "a/.ssh/config",
        ".aws/credentials",
        ".git-credentials",
        ".netrc",
        ".npmrc",
        "a/auth.json",
        "account.json",
        "a/secret.key",
        "a/key.p12",
    ],
)
def test_credential_paths_are_omitted(path: str) -> None:
    assert omission_reason(path, "100644") == "credential_path"


# #196-T02 #196-T03
@pytest.mark.parametrize("mode", ["120000", "160000", "100600", "010644", "040000"])
def test_non_regular_modes_are_never_exported(mode: str) -> None:
    assert omission_reason("source.txt", mode) == "unsafe_mode"


# #196-T05 #196-T10
@pytest.mark.parametrize(
    "path",
    ["AGENTS.md", "a/AGENTS.md", "CONTRIBUTING.md", "CLAUDE.md", "CONTEXT.md", ".env.example"],
)
def test_rule_evidence_and_placeholders_remain_eligible(path: str) -> None:
    assert omission_reason(path, "100644") is None


# #196-T04 #196-T05
@pytest.mark.parametrize("raw", [b"a\x00b", b"\xff", b"a\x01b"])
def test_binary_content_is_omitted(raw: bytes) -> None:
    assert content_text(raw, Redactor(())) is None


# #196-T05
def test_allowed_text_redacts_recognized_and_job_credentials() -> None:
    token = "ghp_" + "A" * 30
    text = content_text(
        (
            f"{token}\nprivate-value\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
        ).encode(),
        Redactor(("private-value",)),
    )
    assert text is not None
    assert token not in text and "private-value" not in text and "abc" not in text
    assert "[REDACTED]" in text
