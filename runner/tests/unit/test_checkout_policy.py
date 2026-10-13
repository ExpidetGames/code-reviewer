# SPDX-License-Identifier: Apache-2.0
"""Checkout policy is applied to names and modes before any blob is read."""

import pytest

from code_reviewer_runner.dynamic_review.content_policy import (
    content_text,
    omission_reason,
    redact_text,
)
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
def test_path_length_and_depth_are_bounded_apart() -> None:
    with pytest.raises(CheckoutError):
        validate_path("a/b/c", Limits(path_depth=2))
    with pytest.raises(CheckoutError):
        validate_path("abcdef", Limits(path_bytes=5))


# #196-T02
def test_path_component_and_depth_boundaries_are_exact() -> None:
    exact_depth = "/".join(["a"] * 32)
    assert validate_path(exact_depth, Limits()) == tuple(["a"] * 32)
    with pytest.raises(CheckoutError):
        validate_path("/".join(["a"] * 33), Limits())
    assert validate_path("a" * 255, Limits())
    with pytest.raises(CheckoutError):
        validate_path("a" * 256, Limits())
    exact_bytes = "/".join(["a" * 204] * 5)
    assert len(exact_bytes.encode()) == 1024
    validate_path(exact_bytes, Limits(path_bytes=1024))
    with pytest.raises(CheckoutError):
        validate_path(exact_bytes + "a", Limits(path_bytes=1024))


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


# #196-T10
@pytest.mark.parametrize(
    "path",
    ["OpenCode.JSON", "a/OpenCode.Jsonc", ".OpenCode/plugins/x.js", ".CLAUDE/Skills/x"],
)
def test_discovery_input_matching_is_case_insensitive(path: str) -> None:
    assert omission_reason(path, "100644") == "engine_discovery"


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


# #196-T05
def test_example_placeholders_stay_readable_and_json_credentials_are_redacted() -> None:
    raw = b'API_KEY=your-api-key\nPASSWORD=<password>\n{"client_secret": "dummy-private-value"}'
    text = content_text(raw, Redactor(()))
    assert text is not None
    assert "your-api-key" in text and "<password>" in text
    assert "dummy-private-value" not in text


# #196-T05
@pytest.mark.parametrize(
    "source",
    [
        "interface A { token: string; password: string }",
        "const token = getToken();",
        "def f(token: str) -> str:",
        "let password: string;",
    ],
)
def test_credential_assignment_redaction_keeps_ordinary_code_intact(source: str) -> None:
    assert redact_text(source, Redactor(())) == source


# #196-T05
def test_credential_assignment_redaction_replaces_only_the_secret_value() -> None:
    text = redact_text('client_secret = "dummy-private-value"', Redactor(()))
    assert text == 'client_secret = "[REDACTED]"'
    assert redact_text("API_KEY=9f8e7d6c5b4a3210", Redactor(())) == "API_KEY=[REDACTED]"


# #196-T05
def test_private_key_blocks_are_redacted_for_pem_and_pgp() -> None:
    for header in (
        "RSA PRIVATE KEY",
        "PRIVATE KEY",
        "ENCRYPTED PRIVATE KEY",
        "PGP PRIVATE KEY BLOCK",
    ):
        text = f"-----BEGIN {header}-----\nsecret-body\n-----END {header}-----"
        assert redact_text(text, Redactor(())) == "[REDACTED]"


# #196-T05
def test_unterminated_private_key_markers_are_redacted_without_a_catastrophic_regex() -> None:
    import time

    line = "-----BEGIN RSA PRIVATE KEY-----\n"
    text = line * (512 * 1024 // len(line))
    started = time.monotonic()
    result = redact_text(text, Redactor(()))
    assert time.monotonic() - started < 10
    assert "PRIVATE KEY" not in result


# #196-T05
@pytest.mark.parametrize(
    "header,size", [("RSA PRIVATE KEY", 10 * 1024), ("PGP PRIVATE KEY BLOCK", 20 * 1024)]
)
def test_a_long_terminated_private_key_block_is_redacted_in_full(header: str, size: int) -> None:
    body = ("A" * 63 + "\n") * (size // 64)
    text = f"before\n-----BEGIN {header}-----\n{body}-----END {header}-----\nafter\n"
    assert redact_text(text, Redactor(())) == "before\n[REDACTED]\nafter\n"


# #196-T05
def test_an_unterminated_private_key_block_is_redacted_to_the_end_of_the_file() -> None:
    text = "before\n-----BEGIN PRIVATE KEY-----\n" + "secret-body\n" * 2000
    assert redact_text(text, Redactor(())) == "before\n[REDACTED]"


# #196-T05
def test_unterminated_markers_after_a_long_block_stay_linear() -> None:
    import time

    block = "-----BEGIN PRIVATE KEY-----\n" + "A" * 100_000 + "\n-----END PRIVATE KEY-----\n"
    line = "-----BEGIN RSA PRIVATE KEY-----\n"
    text = block + line * (512 * 1024 // len(line))
    started = time.monotonic()
    result = redact_text(text, Redactor(()))
    assert time.monotonic() - started < 10
    assert "PRIVATE KEY" not in result and "AAAA" not in result
