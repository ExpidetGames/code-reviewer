"""Turns a job into PR-Agent configuration.

PR-Agent reads settings from Dynaconf, which loads every process environment variable with the
shape SECTION__KEY, and Dynaconf evaluates values that start with `@format`, `@jinja`, `@get` and
similar markers: such a value can read any environment variable or any other setting, a secret
included, into the prompt. Three rules keep that from happening (CR-45):

- Nothing Dynaconf could evaluate is handed over through the environment. The environment only
  holds endpoints, model names and plain runtime variables, and tells Dynaconf not to evaluate
  (`AUTO_CAST_FOR_DYNACONF`) before it reads the first variable.
- The secrets (installation token, LLM key) and everything that comes from the job (the options of
  the four tools) are typed values set with `get_settings().set()` inside the request scope, after
  the same switch was set on that settings object. So the secrets are not in `os.environ`, where a
  `{env[...]}` reference would find them, and a value stays the text that was sent.
- Booleans, integers and lists are typed values as well. As environment strings they would arrive
  as strings, and most checks are plain truthiness (the string "false" is truthy).

Typed values are not restored by PR-Agent after it merges a repository `.pr_agent.toml` (the
environment is), so the settings guard puts them back (`repo_settings_guard`).

The returned environment is complete: it replaces the process environment, so nothing of the parent
process (other secrets, stray CONFIG or GITHUB variables) reaches PR-Agent.
"""

import re
from collections.abc import Callable, Mapping

from code_reviewer_runner.job import OPENROUTER_PREFIX, Command, Job

OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"
# The Dynaconf setting that decides whether `@format`, `@jinja`, ... are evaluated at all.
AUTO_CAST_SETTING = "AUTO_CAST_FOR_DYNACONF"
_INTEGER = re.compile(r"[+-]?[0-9]{1,18}")

# Plain runtime variables the process needs. Everything else of the parent is dropped.
_PASSTHROUGH = (
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "TIKTOKEN_CACHE_DIR",
    "DATA_GYM_CACHE_DIR",
    "PYTHONUNBUFFERED",
)


def _with_prefix(model: str) -> str:
    return model if model.startswith(OPENROUTER_PREFIX) else f"{OPENROUTER_PREFIX}{model}"


def build_environment(job: Job, parent: Mapping[str, str]) -> dict[str, str]:
    """The complete process environment for PR-Agent: no secret and no value from the job."""
    env = {name: parent[name] for name in _PASSTHROUGH if name in parent}
    pinned_model = _with_prefix(job.llm.model)
    env.update(
        {
            # Read by Dynaconf when its settings are created, i.e. before the first variable is
            # parsed. PR-Agent sets the same variable itself, but only after that point.
            AUTO_CAST_SETTING: "false",
            "CONFIG__GIT_PROVIDER": "github",
            "GITHUB__DEPLOYMENT_TYPE": "user",
            "GITHUB__BASE_URL": job.git.base_url,
            # All three model roles are the job's model: PR-Agent uses the weak model for `ask`
            # and `describe` and the reasoning model for self-reflection, and would otherwise
            # fall back to vendor defaults (and send the LLM key to an unintended model).
            "CONFIG__MODEL": pinned_model,
            "CONFIG__MODEL_WEAK": pinned_model,
            "CONFIG__MODEL_REASONING": pinned_model,
            "OPENROUTER__API_BASE": job.llm.base_url or OPENROUTER_API_BASE,
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
            "LITELLM_LOG": "ERROR",
        }
    )
    return env


def build_secret_settings(job: Job) -> dict[str, str]:
    """The credentials of the job as typed settings. Never log or print this mapping."""
    return {
        "github.user_token": job.git.token,
        "openrouter.key": job.llm.api_key,
    }


def build_typed_settings(job: Job) -> dict[str, bool | int | str | list[str]]:
    """Typed overrides, applied with `get_settings().set(key, value)` before the request.

    The order matters: the switch that stops Dynaconf from evaluating values comes first, because
    every later `set` of a text goes through its parser.
    """
    settings: dict[str, bool | int | str | list[str]] = {
        AUTO_CAST_SETTING: False,
        "config.publish_output": True,
        # No temporary "Preparing review..." comment that is created and deleted again.
        "config.publish_output_progress": False,
        # Settings come from the job, the repository file and the PR-Agent defaults only.
        "config.use_global_settings_file": False,
        "config.output_run_cost": True,
        # The job's list, or none: the default fallback model belongs to another vendor.
        "config.fallback_models": [_with_prefix(model) for model in job.llm.fallback_models],
        # A repository file must not move the place its own settings are read from (the default
        # branch) and must not add settings files of directories.
        "config.config_branch": "",
        "config.enable_per_directory_settings": False,
        # A re-run edits the review in place; no second "updated to latest commit" comment.
        "pr_reviewer.final_update_message": False,
        # Review labels need write scope and surprise users.
        "pr_reviewer.enable_review_labels_security": False,
        "pr_reviewer.enable_review_labels_effort": False,
        "litellm.turn_off_message_logging": True,
    }
    if job.llm.max_tokens is not None:
        # PR-Agent uses the first for a model it does not know and clamps every model to the
        # second (default 32000), so both have to follow the job.
        settings["config.custom_model_max_tokens"] = job.llm.max_tokens
        settings["config.max_model_tokens"] = job.llm.max_tokens
    return settings


class InvalidOption(Exception):
    """A value of `job.env` does not fit the type of its option. `key` is the env name."""

    def __init__(self, key: str) -> None:
        super().__init__(f"the value of {key} does not fit the type of the option")
        self.key = key


def option_setting_name(key: str) -> str:
    """`PR_REVIEWER__NUM_MAX_FINDINGS` becomes `pr_reviewer.num_max_findings`."""
    section, _, option = key.lower().partition("__")
    return f"{section}.{option}"


def _typed_option(key: str, text: str, default: object) -> bool | int | float | str:
    if isinstance(default, bool):
        lowered = text.strip().lower()
        if lowered not in ("true", "false"):
            raise InvalidOption(key)
        return lowered == "true"
    if isinstance(default, int):
        if not _INTEGER.fullmatch(text.strip()):
            raise InvalidOption(key)
        return int(text)
    if isinstance(default, float):
        try:
            return float(text)
        except ValueError:
            raise InvalidOption(key) from None
    return text


def build_option_settings(
    options: Mapping[str, str], default_of: Callable[[str], object]
) -> dict[str, bool | int | float | str]:
    """The options of the job as typed settings.

    Dynaconf would turn an environment string into whatever TOML reads (`true`, `123`, `[1]`, a
    date) and evaluate `@format`. Here the type is the type PR-Agent's own default has: a switch
    takes `true` or `false`, a number takes an integer, and everything else, instructions above
    all, stays the text that was sent. A value that does not fit raises `InvalidOption`.
    `default_of` answers with PR-Agent's default for a dotted setting name (None if unknown).
    """
    settings: dict[str, bool | int | float | str] = {}
    for key, text in options.items():
        name = option_setting_name(key)
        settings[name] = _typed_option(key, text, default_of(name))
    return settings


def build_request(job: Job) -> list[str]:
    """The `request` argument of `PRAgent.handle_request`, in its list form."""
    if job.command is not Command.ASK:
        return [job.command.value]
    # Imported here: PR-Agent must only be imported after the environment is in place.
    from pr_agent.algo.utils import encode_user_text_arg

    return ["ask", encode_user_text_arg(job.args[0])]
