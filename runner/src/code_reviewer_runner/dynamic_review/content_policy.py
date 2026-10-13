# SPDX-License-Identifier: Apache-2.0
"""OpenCode v1.19.0 discovery deny-list, applied before blob hydration/reads.

Both config graphs, external plugins and compatible skills are covered. Source links and
outside-export discovery requirements are recorded in docs/dynamic-checkout.md.
"""

import itertools
import re

from code_reviewer_runner.redaction import Redactor

DENY_LIST_VERSION = "opencode-v1.19.0-1"
_CONFIG_NAMES = {"opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"}
_CREDENTIAL_DIRS = {".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker"}
_CREDENTIAL_NAMES = {
    ".git-credentials",
    ".netrc",
    "_netrc",
    ".npmrc",
    ".pypirc",
    "credentials",
    "credentials.json",
    "auth.json",
    "account.json",
    "accounts.json",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
}
_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----.*?"
    r"-----END (?:[A-Z0-9 ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----",
    re.DOTALL,
)
_ASSIGNMENT = re.compile(
    r"(?im)\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*"
    r"[\"']?[^\s\"',;]+"
)


def omission_reason(path: str, mode: str) -> str | None:
    parts = path.lower().split("/")
    if ".opencode" in parts or parts[-1] in _CONFIG_NAMES:
        return "engine_discovery"
    if any(a in (".claude", ".agents") and b == "skills" for a, b in itertools.pairwise(parts)):
        return "engine_discovery"
    if any(
        (part.startswith(".env") and part != ".env.example")
        or part in _CREDENTIAL_DIRS
        or part in _CREDENTIAL_NAMES
        or part.endswith((".pem", ".key", ".p12", ".pfx", ".keystore"))
        for part in parts
    ):
        return "credential_path"
    if mode not in ("100644", "100755"):
        return "unsafe_mode"
    return None


def redact_text(text: str, redactor: Redactor) -> str:
    return _ASSIGNMENT.sub("[REDACTED]", _PRIVATE_KEY.sub("[REDACTED]", redactor.redact(text)))


def content_text(raw: bytes, redactor: Redactor) -> str | None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if any(ord(char) < 32 and char not in "\n\r\t" for char in text) or "\x7f" in text:
        return None
    return redact_text(text, redactor)
