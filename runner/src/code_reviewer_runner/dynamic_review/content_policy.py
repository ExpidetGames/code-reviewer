# SPDX-License-Identifier: Apache-2.0
"""OpenCode v1.19.0 discovery deny-list, applied before blob hydration/reads.

Both config graphs, external plugins and compatible skills are covered. Source links and
outside-export discovery requirements are recorded in docs/dynamic-checkout.md.
"""

import itertools
import re
from enum import StrEnum

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
    r"(?im)\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key|"
    r"client[_-]?secret|private[_-]?key|token)[\"']?\s*[:=]\s*[\"']?"
    r"(?P<value>[^\s\"',;]+)"
)
_PLACEHOLDERS = {"placeholder", "changeme", "example", "your-api-key", "your-token", "your-key"}


def _redact_assignment(match: re.Match[str]) -> str:
    value = match.group("value")
    if value.lower() in _PLACEHOLDERS or (value.startswith("<") and value.endswith(">")):
        return match.group()
    return "[REDACTED]"


class OmissionReason(StrEnum):
    ENGINE_DISCOVERY = "engine_discovery"
    CREDENTIAL_PATH = "credential_path"
    UNSAFE_MODE = "unsafe_mode"
    LARGE_FILE = "large_file"
    BINARY = "binary"


def omission_reason(path: str, mode: str) -> OmissionReason | None:
    parts = path.lower().split("/")
    if ".opencode" in parts or parts[-1] in _CONFIG_NAMES:
        return OmissionReason.ENGINE_DISCOVERY
    if any(a in (".claude", ".agents") and b == "skills" for a, b in itertools.pairwise(parts)):
        return OmissionReason.ENGINE_DISCOVERY
    if any(
        (part.startswith(".env") and part != ".env.example")
        or part in _CREDENTIAL_DIRS
        or part in _CREDENTIAL_NAMES
        or part.endswith((".pem", ".key", ".p12", ".pfx", ".keystore"))
        for part in parts
    ):
        return OmissionReason.CREDENTIAL_PATH
    if mode not in ("100644", "100755"):
        return OmissionReason.UNSAFE_MODE
    return None


def redact_text(text: str, redactor: Redactor) -> str:
    return _ASSIGNMENT.sub(
        _redact_assignment, _PRIVATE_KEY.sub("[REDACTED]", redactor.redact(text))
    )


def content_text(raw: bytes, redactor: Redactor) -> str | None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if any(ord(char) < 32 and char not in "\n\r\t" for char in text) or "\x7f" in text:
        return None
    return redact_text(text, redactor)
