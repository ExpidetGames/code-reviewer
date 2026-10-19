# SPDX-License-Identifier: Apache-2.0

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

from code_reviewer_runner.job import RESERVED_OPTIONS, Job
from code_reviewer_runner.llm_providers import require_provider, with_prefix, without_prefix
from code_reviewer_runner.platforms import Platform, platform_for

# A value `get_settings().set()` is given: a switch, a number, a text, a list of texts or of
# records (the injection points of the prompt cache).
TypedSetting = bool | int | str | list[str] | list[dict[str, str]]

# The Dynaconf setting that decides whether `@format`, `@jinja`, ... are evaluated at all.
AUTO_CAST_SETTING = "AUTO_CAST_FOR_DYNACONF"
_INTEGER = re.compile(r"[+-]?[0-9]{1,18}")

# Plain runtime variables the process needs. Everything else of the parent is dropped. The job
# loop uses the same list for the environment of a job process.
PASSTHROUGH_VARIABLES = (
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


def _platform_of(job: Job) -> Platform:
    platform = platform_for(job.git.provider)
    if platform is None:
        # parse_job refuses an unknown provider; this only guards a Job built by hand.
        raise ValueError("unsupported git provider")
    return platform


def build_environment(job: Job, parent: Mapping[str, str]) -> dict[str, str]:
    """The complete process environment for PR-Agent: no secret and no value from the job."""
    platform = _platform_of(job)
    env = {name: parent[name] for name in PASSTHROUGH_VARIABLES if name in parent}
    provider = require_provider(job.llm.provider)
    pinned_model = with_prefix(provider, job.llm.model)
    env.update(
        {
            # Read by Dynaconf when its settings are created, i.e. before the first variable is
            # parsed. PR-Agent sets the same variable itself, but only after that point.
            AUTO_CAST_SETTING: "false",
            "CONFIG__GIT_PROVIDER": platform.git_provider,
            platform.deployment_type_variable: platform.deployment_type,
            platform.base_url_variable: job.git.base_url,
            # All three model roles are the job's model: PR-Agent uses the reasoning model for
            # self-reflection and the weak model for some sub-tasks, and would otherwise fall back
            # to vendor defaults (and send the LLM key to an unintended model).
            "CONFIG__MODEL": pinned_model,
            "CONFIG__MODEL_WEAK": pinned_model,
            "CONFIG__MODEL_REASONING": pinned_model,
            provider.api_base_variable: provider.litellm_api_base(
                job.llm.base_url or provider.default_api_base
            ),
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
            "LITELLM_LOG": "ERROR",
        }
    )
    return env


def build_secret_settings(job: Job) -> dict[str, str]:
    """The credentials of the job as typed settings. Never log or print this mapping."""
    return {
        _platform_of(job).token_setting: job.git.token,
        require_provider(job.llm.provider).key_setting: job.llm.api_key,
    }


def build_typed_settings(job: Job) -> dict[str, TypedSetting]:
    """Typed overrides, applied with `get_settings().set(key, value)` before the request.

    The order matters: the switch that stops Dynaconf from evaluating values comes first, because
    every later `set` of a text goes through its parser.
    """
    provider = require_provider(job.llm.provider)
    settings: dict[str, TypedSetting] = {
        AUTO_CAST_SETTING: False,
        "config.publish_output": True,
        # No temporary "Preparing review..." comment that is created and deleted again.
        "config.publish_output_progress": False,
        # Settings come from the job, the repository file and the PR-Agent defaults only.
        "config.use_global_settings_file": False,
        # PR-Agent prices a call from a price table when the answer states no charge. The cost of
        # a run is measured from the provider's own `usage.cost` instead (`diff_cost.py`, #274).
        "config.output_run_cost": False,
        # Neither section that prints the model into the published review comment ("Agent run
        # details", the `config` section of the relevant configurations). The model of a managed
        # tier is operator data (#280); both are off by default in PR-Agent 0.47.0, but a
        # repository file could turn them on.
        "config.output_run_details": False,
        "config.output_relevant_configurations": False,
        # LiteLLM and its client send a request again inside one call when this is set (or left to
        # their defaults): the meter would see only the last answer. Retries are PR-Agent's own
        # attempts, each of which passes the meter (#274).
        "config.num_retries": 0,
        # The job's list, or none: the default fallback model belongs to another vendor.
        "config.fallback_models": [
            with_prefix(provider, model) for model in job.llm.fallback_models
        ],
        # A repository file must not move the place its own settings are read from (the default
        # branch) and must not add settings files of directories.
        "config.config_branch": "",
        "config.enable_per_directory_settings": False,
        # Context files such as AGENTS.md come from the default branch, never from the branch a
        # pull request targets (a repository file could otherwise switch this).
        "config.repo_context_from_default_branch": True,
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
    else:
        # No budget in the job: a model PR-Agent does not know still has the window of the
        # provider's list (the default clamp of 32000 stays).
        window = provider.context_window(without_prefix(provider, job.llm.model))
        if window is not None:
            settings["config.custom_model_max_tokens"] = window
    if "claude" in job.llm.model.lower():
        # Prompt caching (#539): LiteLLM marks the system message, the instructions of the tool
        # that the calls of a run and the runs of a workspace within five minutes have in common.
        # The user message holds the diff, which is unique: caching it would add the write premium
        # to a prompt that is read once. PR-Agent forwards the setting only for a model whose name
        # says `claude` (the test here is the same one) and sets no lifetime, so it is the
        # provider's five minutes. The `litellm` section is pinned against a repository file.
        settings["litellm.cache_control_injection_points"] = [
            {"location": "message", "role": "system"}
        ]
    # What a model is asked to write at most. Reasoning counts against it, and the default of the
    # provider's client can be used up before the review is written.
    output = provider.diff_output_tokens(without_prefix(provider, job.llm.model))
    if output is not None:
        settings["config.max_output_tokens"] = output
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


def _typed_option(key: str, text: str, default: object) -> bool | int | str:
    if isinstance(default, bool):
        lowered = text.strip().lower()
        if lowered not in ("true", "false"):
            raise InvalidOption(key)
        return lowered == "true"
    if isinstance(default, int):
        if not _INTEGER.fullmatch(text.strip()):
            raise InvalidOption(key)
        return int(text)
    return text


def build_option_settings(
    options: Mapping[str, str], default_of: Callable[[str], object]
) -> dict[str, bool | int | str]:
    """The options of the job as typed settings.

    Dynaconf would turn an environment string into whatever TOML reads (`true`, `123`, `[1]`, a
    date) and evaluate `@format`. Here the type is the type PR-Agent's own default has: a switch
    takes `true` or `false`, a number takes an integer, and everything else, instructions above
    all, stays the text that was sent. A value that does not fit raises `InvalidOption`.
    `default_of` answers with PR-Agent's default for a dotted setting name (None if unknown).
    """
    settings: dict[str, bool | int | str] = {}
    for key, text in options.items():
        if key in RESERVED_OPTIONS:
            # parse_job refuses these names; the runner's own value must win in any case.
            raise InvalidOption(key)
        name = option_setting_name(key)
        settings[name] = _typed_option(key, text, default_of(name))
    return settings


def build_request(job: Job) -> list[str]:
    """The `request` argument of `PRAgent.handle_request`, in its list form.

    `/review` is the only command (#203), and it takes no arguments, so the request is one word.
    """
    return [job.command.value]
