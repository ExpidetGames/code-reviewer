# SPDX-License-Identifier: Apache-2.0

"""The job the runner reads from stdin, and its validation.

Shape (basis of the runner contract v1, see the lead decisions for CR-10):

    {
      "prUrl": "https://github.com/<owner>/<repo>/pull/<n>",
      "command": "review",
      "git": {"provider": "github", "baseUrl": "https://api.github.com",
              "token": "<installation token>", "botLogin": "<app slug>[bot]"},
      "llm": {"provider": "openrouter", "model": "<vendor>/<model>", "apiKey": "<key>",
              "baseUrl": "http://127.0.0.1:<port>/api/v1",     // optional, loopback only (fakes)
              "maxTokens": 163840,                             // optional, context window
              "fallbackModels": ["<vendor>/<model>"]},         // optional, at most five
      "env": {"PR_REVIEWER__EXTRA_INSTRUCTIONS": "<string>"}   // optional, tool settings only
    }

`/review` is the only command (the product removed `/ask`, `/improve` and `/describe`). A job that
names a removed command is refused with `invalid_command` before PR-Agent is loaded; that failure is
reported for the job (the loop completes it), so a mixed deployment never strands it. For a `review`
job the runner stays compatible with the previous release's v1 payload: the legacy `args` field and
the option families of the removed tools (`PR_DESCRIPTION__*`, `PR_CODE_SUGGESTIONS__*`,
`PR_QUESTIONS__*`) are **accepted and ignored** — they are never handed to PR-Agent. The `env` the
runner builds holds only `PR_REVIEWER__*` settings. Everything that decides where a credential or a
request goes (GitHub and LLM endpoints, tokens, the model, output switches) has its own validated
field above or is pinned by the runner. Values of `env` are text: PR-Agent never evaluates them (see
`pr_agent_config.build_option_settings`).

Validation never echoes a value from the job into its error detail: the job holds secrets, and the
detail ends up in the result JSON and in logs. Details name fields, never contents.
"""

import json
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, NoReturn
from urllib.parse import SplitResult, urlsplit

from code_reviewer_runner.platforms import PLATFORMS
from code_reviewer_runner.result import ErrorCode

MAX_JOB_BYTES = 1024 * 1024
MAX_SECRET_CHARS = 4096

_TOP_LEVEL_FIELDS = {"prUrl", "command", "args", "git", "llm", "env"}
_GIT_FIELDS = {"provider", "baseUrl", "token", "botLogin"}
_LLM_FIELDS = {"provider", "model", "apiKey", "baseUrl", "maxTokens", "fallbackModels"}
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MIN_CONTEXT_TOKENS = 1000
MAX_CONTEXT_TOKENS = 10_000_000
# A fallback chain longer than this only multiplies the cost and the time of a failing review.
MAX_FALLBACK_MODELS = 5
_FIELD_NAME = re.compile(r"[A-Za-z0-9_.-]{1,40}")
_PR_PATH = re.compile(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]{0,8})")
# The login the review app posts as: its slug (letters, digits and hyphens, not starting with a
# hyphen, at most 39 characters) with the optional `[bot]` suffix that GitHub adds. Use `fullmatch`,
# so that nothing may precede or follow it, not even a newline. The only definition: `parse_job` and
# the identity patch (identity_patch.py) both validate with it.
BOT_LOGIN_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?")
_MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}")
# `env` may only set the options of the PR-Agent tools. An allowlist instead of a list of forbidden
# keys: PR-Agent has many sections (litellm, openai, azure, push_outputs, ...) that route requests
# or credentials, and a new PR-Agent version can add more. One option name per key: a second `__`
# would address a nested value.
# The previous release's app could send the option families of the removed tools; they are accepted
# (v1 compatibility) but ignored, never handed to PR-Agent. Only the review family reaches the job.
_ENV_KEY = re.compile(
    r"(PR_REVIEWER|PR_DESCRIPTION|PR_CODE_SUGGESTIONS|PR_QUESTIONS)__[A-Z0-9]+(_[A-Z0-9]+)*"
)
_REMOVED_TOOL_ENV_KEY = re.compile(
    r"(PR_DESCRIPTION|PR_CODE_SUGGESTIONS|PR_QUESTIONS)__[A-Z0-9]+(_[A-Z0-9]+)*"
)
# The names of the options the runner sets itself (switches that decide what is published). A job
# may not set them: the runner's value must win, and a repository file may not change them either
# (see `repo_settings_guard.PROTECTED_SETTINGS`, which a test compares with this list).
RESERVED_OPTIONS = frozenset(
    {
        "PR_REVIEWER__FINAL_UPDATE_MESSAGE",
        "PR_REVIEWER__ENABLE_REVIEW_LABELS_SECURITY",
        "PR_REVIEWER__ENABLE_REVIEW_LABELS_EFFORT",
    }
)
OPENROUTER_PREFIX = "openrouter/"


def with_openrouter_prefix(model: str) -> str:
    """The model name as PR-Agent needs it to route through OpenRouter."""
    return model if model.startswith(OPENROUTER_PREFIX) else f"{OPENROUTER_PREFIX}{model}"


def without_openrouter_prefix(model: str) -> str:
    """The model name without the routing prefix, to compare two names."""
    return model.removeprefix(OPENROUTER_PREFIX)


class Command(StrEnum):
    REVIEW = "review"


class JobError(Exception):
    """The job was refused. `detail` is safe to log: it names fields and never contains values."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class GitAccess:
    base_url: str
    token: str
    bot_login: str
    provider: str = "github"


@dataclass(frozen=True)
class LlmAccess:
    model: str
    api_key: str
    base_url: str | None = None
    max_tokens: int | None = None
    fallback_models: tuple[str, ...] = ()


@dataclass(frozen=True)
class Job:
    pr_url: str
    command: Command
    git: GitAccess
    llm: LlmAccess
    env: dict[str, str] = field(default_factory=lambda: {})

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every value that must never appear in an output."""
        # `env` is a closed list of tool options and holds no credentials, so its values are not
        # secrets: treating a value such as "true" as one would blank the result of a good run.
        return (self.git.token, self.llm.api_key)


def _invalid(detail: str) -> JobError:
    return JobError(ErrorCode.INVALID_JOB, detail)


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(f"{path} must be an object")
    return value  # pyright: ignore[reportUnknownVariableType]


def _section(data: dict[str, Any], key: str) -> dict[str, Any]:
    if key not in data:
        raise _invalid(f"{key} is required")
    return _object(data[key], key)


def _check_fields(data: dict[str, Any], allowed: set[str], prefix: str) -> None:
    for key in data:
        if key not in allowed:
            # A key name is part of the input too: only echo it when it looks like a plain name.
            shown = key if _FIELD_NAME.fullmatch(key) else "<invalid name>"
            raise _invalid(f"unknown field {prefix}{shown}")


def _string(data: dict[str, Any], key: str, prefix: str, *, max_chars: int = 2048) -> str:
    value = data.get(key)
    if value is None:
        raise _invalid(f"{prefix}{key} is required")
    if not isinstance(value, str) or not value.strip() or len(value) > max_chars:
        raise _invalid(f"{prefix}{key} must be a non-empty string")
    return value


def _secret(data: dict[str, Any], key: str, prefix: str) -> str:
    value = _string(data, key, prefix, max_chars=MAX_SECRET_CHARS)
    if any(char.isspace() or not char.isprintable() for char in value):
        raise _invalid(f"{prefix}{key} must not contain whitespace or control characters")
    return value


def _checked_url(value: str, field_name: str) -> SplitResult:
    try:
        parts = urlsplit(value)
        _ = parts.port  # raises ValueError for a malformed port
    except ValueError:
        raise _invalid(f"{field_name} is not a valid URL") from None
    host = parts.hostname or ""
    secure = parts.scheme == "https"
    local_http = parts.scheme == "http" and host in _LOOPBACK_HOSTS
    if not host or not (secure or local_http):
        raise _invalid(f"{field_name} must be an https URL (http only for loopback)")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise _invalid(f"{field_name} must not contain credentials, a query or a fragment")
    return parts


def _git_access(data: dict[str, Any]) -> GitAccess:
    git = _section(data, "git")
    _check_fields(git, _GIT_FIELDS, "git.")
    provider = _string(git, "provider", "git.")
    if provider not in PLATFORMS:
        raise _invalid(f"git.provider must be one of: {', '.join(sorted(PLATFORMS))}")
    base_url = _string(git, "baseUrl", "git.").rstrip("/")
    _checked_url(base_url, "git.baseUrl")
    token = _secret(git, "token", "git.")
    bot_login = _string(git, "botLogin", "git.")
    if not BOT_LOGIN_PATTERN.fullmatch(bot_login):
        raise _invalid("git.botLogin must be an app slug, optionally with the [bot] suffix")
    return GitAccess(
        provider=provider,
        base_url=base_url,
        token=token,
        bot_login=bot_login if bot_login.endswith("[bot]") else f"{bot_login}[bot]",
    )


def _llm_access(data: dict[str, Any]) -> LlmAccess:
    llm = _section(data, "llm")
    _check_fields(llm, _LLM_FIELDS, "llm.")
    if _string(llm, "provider", "llm.") != "openrouter":
        raise _invalid("llm.provider must be 'openrouter'")
    model = _string(llm, "model", "llm.")
    if not _MODEL.fullmatch(model):
        raise _invalid("llm.model contains characters that are not allowed in a model name")
    return LlmAccess(
        model=model,
        api_key=_secret(llm, "apiKey", "llm."),
        base_url=_llm_base_url(llm),
        max_tokens=_max_tokens(llm),
        fallback_models=_fallback_models(llm, model),
    )


def _llm_base_url(llm: dict[str, Any]) -> str | None:
    if "baseUrl" not in llm:
        return None
    base_url = _string(llm, "baseUrl", "llm.").rstrip("/")
    parts = _checked_url(base_url, "llm.baseUrl")
    # The shared LLM key goes to this address, so it may only point at a local fake.
    if (parts.hostname or "") not in _LOOPBACK_HOSTS:
        raise _invalid("llm.baseUrl is only accepted for loopback addresses")
    return base_url


def _max_tokens(llm: dict[str, Any]) -> int | None:
    if "maxTokens" not in llm:
        return None
    value = llm["maxTokens"]
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid("llm.maxTokens must be an integer")
    if not MIN_CONTEXT_TOKENS <= value <= MAX_CONTEXT_TOKENS:
        raise _invalid("llm.maxTokens is out of range")
    return value


def _fallback_models(llm: dict[str, Any], primary: str) -> tuple[str, ...]:
    if "fallbackModels" not in llm:
        return ()
    value: Any = llm["fallbackModels"]
    if not isinstance(value, list):
        raise _invalid("llm.fallbackModels must be a list of model names")
    models: list[Any] = value  # pyright: ignore[reportUnknownVariableType]
    if len(models) > MAX_FALLBACK_MODELS:
        raise _invalid(f"llm.fallbackModels may hold at most {MAX_FALLBACK_MODELS} models")
    seen = {without_openrouter_prefix(primary)}
    for model in models:
        if not isinstance(model, str) or not _MODEL.fullmatch(model):
            raise _invalid("llm.fallbackModels must hold valid model names")
        if without_openrouter_prefix(model) in seen:
            raise _invalid("llm.fallbackModels must not repeat a model or the primary model")
        seen.add(without_openrouter_prefix(model))
    return tuple(models)


def _web_host(api_base_url: str) -> str:
    """The host a pull request URL must have for this API base URL."""
    netloc = urlsplit(api_base_url).netloc
    return "github.com" if netloc == "api.github.com" else netloc


def _pr_url(data: dict[str, Any], git: GitAccess) -> str:
    value = _string(data, "prUrl", "")
    # urlsplit silently drops tabs and newlines, so the raw text has to be checked here.
    if any(char.isspace() or not char.isprintable() for char in value):
        raise _invalid("prUrl must not contain whitespace or control characters")
    parts = _checked_url(value, "prUrl")
    if parts.netloc != _web_host(git.base_url):
        raise _invalid("prUrl must point to the host of git.baseUrl")
    if not _PR_PATH.fullmatch(parts.path):
        raise _invalid("prUrl must look like https://<host>/<owner>/<repo>/pull/<number>")
    return value


def _refuse_command() -> NoReturn:
    raise JobError(ErrorCode.INVALID_COMMAND, "command is not one of the allowed commands")


def _command(data: dict[str, Any]) -> Command:
    if "command" not in data:
        raise _invalid("command is required")
    value = data["command"]
    if not isinstance(value, str):
        _refuse_command()
    try:
        return Command(value)
    except ValueError:
        _refuse_command()


def _env(data: dict[str, Any]) -> dict[str, str]:
    """The review tool's options. A legacy option of a removed tool is accepted and dropped."""
    if data.get("env") is None:
        return {}
    env: dict[str, str] = {}
    for key, value in _object(data["env"], "env").items():
        if not _ENV_KEY.fullmatch(key):
            raise _invalid("env may only set options of the PR-Agent tools")
        if not isinstance(value, str):
            raise _invalid("env values must be strings")
        # A previous release sent the removed tools' options too; they are ignored, so they never
        # reach PR-Agent (which no longer runs those tools).
        if _REMOVED_TOOL_ENV_KEY.fullmatch(key):
            continue
        if key in RESERVED_OPTIONS:
            raise _invalid(f"env option {key} is set by the runner and cannot be set by a job")
        env[key] = value
    return env


def parse_job(raw: str) -> Job:
    """Parse and validate the stdin text. Raises JobError; never returns a half valid job."""
    if len(raw) > MAX_JOB_BYTES:
        raise _invalid("the job is larger than 1 MiB")
    try:
        data: Any = json.loads(raw)
    except (ValueError, RecursionError):  # RecursionError: absurdly deep nesting
        raise _invalid("stdin is not valid JSON") from None
    job = _object(data, "the job")
    command = _command(job)
    # `args` (the legacy question of the removed `/ask`) is an allowed field so a previous release's
    # payload still parses for a review; it is never read, so it never reaches PR-Agent.
    _check_fields(job, _TOP_LEVEL_FIELDS, "")
    git = _git_access(job)
    llm = _llm_access(job)
    return Job(
        pr_url=_pr_url(job, git),
        command=command,
        git=git,
        llm=llm,
        env=_env(job),
    )
