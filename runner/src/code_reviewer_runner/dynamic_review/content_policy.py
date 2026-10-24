# SPDX-License-Identifier: LicenseRef-Proprietary
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
_PRIVATE_KEY_BEGIN = "-----BEGIN "
_PRIVATE_KEY_END = "-----END "
_ASSIGNMENT = re.compile(
    r"(?im)\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key|"
    r"client[_-]?secret|private[_-]?key|token)\b[\"']?(?P<prefix>\s*[:=]\s*)"
    r"(?P<quote>[\"']?)(?P<value>[^\s\"',;]+)(?P=quote)"
)
_PLACEHOLDERS = {"placeholder", "changeme", "example", "your-api-key", "your-token", "your-key"}


def _private_key_end(text: str, search: int) -> int | None:
    while True:
        marker = text.find(_PRIVATE_KEY_END, search)
        if marker < 0:
            return None
        after = marker + len(_PRIVATE_KEY_END)
        end = text.find("-----", after, after + 64)
        if end >= 0 and _is_private_key_header(text[after:end]):
            return end + 5
        search = after


def _is_private_key_header(header: str) -> bool:
    return header.endswith("PRIVATE KEY") or header == "PGP PRIVATE KEY BLOCK"


def _redact_private_keys(text: str) -> str:
    """Linearly replace whole PEM/PGP private-key blocks, without a catastrophic regex.

    One forward pass pairs each BEGIN with the next valid END, however long the block. An
    unterminated block is redacted to the end of the text, so the scan never restarts behind
    a BEGIN and stays linear.
    """
    if _PRIVATE_KEY_BEGIN not in text:
        return text
    result: list[str] = []
    position = 0
    while True:
        start = text.find(_PRIVATE_KEY_BEGIN, position)
        if start < 0:
            result.append(text[position:])
            return "".join(result)
        after = start + len(_PRIVATE_KEY_BEGIN)
        header_end = text.find("-----", after, after + 64)
        if header_end < 0 or not _is_private_key_header(text[after:header_end]):
            result.append(text[position:after])
            position = after
            continue
        end = _private_key_end(text, header_end + 5)
        result.append(text[position:start])
        result.append("[REDACTED]")
        position = end if end is not None else len(text)


def _looks_like_secret(value: str) -> bool:
    if value.lower() in _PLACEHOLDERS or (value.startswith("<") and value.endswith(">")):
        return False
    if len(value) >= 16:
        return True
    return any(char.isalpha() for char in value) and any(char.isdigit() for char in value)


def _redact_assignment(match: re.Match[str]) -> str:
    value = match.group("value")
    # Keep the key and the statement shape; only a secret-looking value is replaced, so an
    # ordinary `token: string` / `token = getToken()` is not mangled into broken code.
    if value.lower() in _PLACEHOLDERS or (value.startswith("<") and value.endswith(">")):
        return match.group()
    if not match.group("quote") and not _looks_like_secret(value):
        return match.group()
    start, end = match.start("value"), match.end("value")
    offset = match.start()
    return match.group()[: start - offset] + "[REDACTED]" + match.group()[end - offset :]


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
    return _ASSIGNMENT.sub(_redact_assignment, _redact_private_keys(redactor.redact(text)))


def content_text(raw: bytes, redactor: Redactor) -> str | None:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if any(ord(char) < 32 and char not in "\n\r\t" for char in text) or "\x7f" in text:
        return None
    return redact_text(text, redactor)
