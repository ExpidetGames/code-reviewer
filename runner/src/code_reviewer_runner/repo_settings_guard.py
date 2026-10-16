# SPDX-License-Identifier: Apache-2.0

# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
"""Keeps a reviewed repository from taking over what the host decides.

A repository may ship a `.pr_agent.toml`, which PR-Agent merges into its settings while it prepares
a command. In 0.47.0 only some host-level keys are protected from that file; for example
`config.model`, `config.custom_model_max_tokens`, `config.publish_output` and the whole `litellm`
section (extra request headers, callbacks) can be replaced by the repository. Values that come from
the process environment are put back by PR-Agent itself, but typed values and values nobody set
are not.

The guard snapshots the protected settings once the runner has configured them and puts them back
after every settings file PR-Agent merges. Options a repository is meant to set (instructions,
thresholds) are untouched. The keys are listed explicitly: a new PR-Agent version is reviewed
against this list when the pin changes (see identity_patch.PATCHED_FOR_VERSION). The options the
job sets (`job.env`) are pinned too, so a repository file cannot override what the project's
settings in the app say.

It also keeps Dynaconf from evaluating what a repository file contains. A value that starts with
`@format` or `@jinja` is evaluated when it is read, and can read an environment variable or any
other setting (a secret) into the prompt. Dynaconf only does that while its
`AUTO_CAST_FOR_DYNACONF` setting is on. The guard sets it off before each merge and again after it,
and as a safety net turns any value that is still waiting for evaluation back into its text.
"""

import copy
import importlib
from collections.abc import Callable, Iterable
from typing import Any

from code_reviewer_runner.pr_agent_config import AUTO_CAST_SETTING

# Settings that route a request or a credential, decide which model runs or what a call may cost,
# or switch publishing and callbacks. Dotted names as used by Dynaconf's `get` and `set`.
PROTECTED_SETTINGS = (
    AUTO_CAST_SETTING,
    "config.model",
    "config.model_weak",
    "config.model_reasoning",
    "config.fallback_models",
    "config.custom_model_max_tokens",
    "config.max_model_tokens",
    "config.ai_timeout",
    "config.git_provider",
    "config.publish_output",
    "config.publish_output_progress",
    "config.use_global_settings_file",
    "config.config_branch",
    "config.enable_per_directory_settings",
    "config.output_run_cost",
    # Both add the model (and `model_weak`, `model_reasoning`) to the published review comment. A
    # tier's model is operator data a workspace must not read (#280), so a repository file must
    # not switch them on.
    "config.output_run_details",
    "config.output_relevant_configurations",
    "config.verbosity_level",
    "config.extra_config_url",
    "config.secret_provider",
    "config.repo_context_from_default_branch",
    # What a call may cost: output and context budgets, reasoning and thinking budgets.
    "config.max_output_tokens",
    "config.max_description_tokens",
    "config.max_commits_tokens",
    "config.model_token_count_estimate_factor",
    "config.image_input_token_allowance",
    "config.custom_reasoning_model",
    "config.reasoning_effort",
    "config.additional_reasoning_effort_models",
    "config.no_temperature_models",
    "config.retry_same_model_on_timeout",
    "config.num_retries",
    "config.add_user_to_requests",
    "config.enable_claude_extended_thinking",
    "config.extended_thinking_budget_tokens",
    "config.extended_thinking_max_output_tokens",
    "config.enable_claude_adaptive_thinking",
    "config.claude_adaptive_thinking_models_override",
    "config.claude_extended_thinking_models_override",
    "openrouter.key",
    "openrouter.api_base",
    "openai.key",
    "openai.api_base",
    "openai.api_type",
    "openai.api_version",
    "github.user_token",
    "github.base_url",
    "github.deployment_type",
    "github.private_key",
    "github.app_id",
    "litellm.extra_headers",
    "litellm.custom_llm_provider",
    "litellm.enable_callbacks",
    "litellm.success_callback",
    "litellm.failure_callback",
    "litellm.service_callback",
    "litellm.turn_off_message_logging",
    "litellm.force_streaming_custom_llm_provider",
    "litellm.force_streaming_api_base_substrings",
    "pr_reviewer.final_update_message",
    "pr_reviewer.enable_review_labels_security",
    "pr_reviewer.enable_review_labels_effort",
)

# Sections in which every key selects a model or a provider, routes a request, sets an endpoint or a
# credential, or bounds what a call costs. They are pinned as a whole, so a key PR-Agent does not
# declare in its defaults (`litellm.model_id`, `litellm.drop_params`) cannot be added either. The
# provider sections are those PR-Agent reads a key or an endpoint from (`PROVIDER_SETTING_PATHS`
# in its LiteLLM handler; a test compares them, so a new provider after an upgrade is noticed).
PROTECTED_SECTIONS = (
    "model_routing",
    "openrouter",
    "litellm",
    "openai",
    "azure_ad",
    "aws",
    "vertexai",
    "anthropic",
    "codestral",
    "cohere",
    "dashscope",
    "databricks",
    "deepinfra",
    "deepseek",
    "google_ai_studio",
    "groq",
    "huggingface",
    "mistral",
    "moonshot",
    "ollama",
    "replicate",
    "sambanova",
    "xai",
    "xiaomi_mimo",
    "zai",
)

# The functions of PR-Agent's git provider utilities that merge a settings file into the settings.
_MERGE_FUNCTIONS = ("_apply_repo_settings_file", "_apply_settings_from_file")


def _waits_for_evaluation(value: object) -> bool:
    """True for Dynaconf's `Lazy` (`@format`, `@jinja`, `@get`, ...) and its meta values.

    The classes, not their marker attributes: a settings section answers any attribute name with
    the key of that name, so a repository file with a key `_meta_value` would look like one.
    """
    parse_conf = importlib.import_module("dynaconf.utils.parse_conf")
    return isinstance(value, (parse_conf.Lazy, parse_conf.MetaValue))


# Names under which Dynaconf looks for its markers with `getattr`. A section answers any attribute
# name with the key of that name, so a repository file with such a key makes Dynaconf treat the
# whole section as a marker and fail on every later read of it.
_MARKER_KEYS = frozenset(
    {
        "_dynaconf_lazy_format",
        "_dynaconf_merge",
        "_dynaconf_merge_unique",
        "_dynaconf_del",
        "_dynaconf_reset",
        "_dynaconf_insert",
        "_dynaconf_dictvalue",
        "_meta_value",
    }
)
_ABSENT = object()


def _text_of(value: Any) -> str:
    try:
        return str(value._dynaconf_encode())
    except Exception:
        return str(value)


def neutralize_unevaluated_values(settings: Any) -> int:
    """Turn every value that waits for evaluation back into its text; returns how many there were.

    Works on the raw store without going through Dynaconf's parser, which would make the text lazy
    again. Keys named like one of Dynaconf's markers are dropped (and counted). Only the number is
    reported: the names of the keys come from the repository.
    """
    count = 0

    def walk(node: Any) -> None:
        nonlocal count
        if isinstance(node, dict):
            for name in list(dict.keys(node)):
                if isinstance(name, str) and name.lower() in _MARKER_KEYS:
                    dict.__delitem__(node, name)
                    count += 1
            # dict.items and list.__iter__ read the raw values; a Dynaconf node evaluates on access.
            for key, value in list(dict.items(node)):
                if _waits_for_evaluation(value):
                    dict.__setitem__(node, key, _text_of(value))
                    count += 1
                else:
                    walk(value)
        elif isinstance(node, list):
            for index, value in enumerate(list(node)):
                if _waits_for_evaluation(value):
                    list.__setitem__(node, index, _text_of(value))
                    count += 1
                else:
                    walk(value)

    walk(settings.store)
    return count


def _find(settings: Any, dotted_name: str) -> tuple[dict[Any, Any], Any] | None:
    """The raw dict that holds a dotted setting and the name it is stored under, or None.

    Reads the store directly: `settings.get` with a dotted name writes its default into the store.
    """
    *parents, leaf = dotted_name.lower().split(".")
    node: Any = settings.store
    for part in parents:
        found = next((k for k in dict.keys(node) if str(k).lower() == part), None)
        if found is None or not isinstance(dict.get(node, found), dict):
            return None
        node = dict.get(node, found)
    name = next((k for k in dict.keys(node) if str(k).lower() == leaf), None)
    return None if name is None else (node, name)


def _peek(settings: Any, dotted_name: str) -> Any:
    """A copy of the value of a dotted setting, or `_ABSENT` itself (a copy would not be it)."""
    located = _find(settings, dotted_name)
    if located is None:
        return _ABSENT
    node, name = located
    return copy.deepcopy(settings.get(dotted_name) if "." in dotted_name else dict.get(node, name))


def _forget(settings: Any, dotted_name: str) -> None:
    """Remove a dotted setting from the raw store, whatever the case of its names."""
    located = _find(settings, dotted_name)
    if located is not None:
        dict.__delitem__(*located)


class RepoSettingsGuard:
    def __init__(self) -> None:
        self._pinned: dict[str, Any] = {}
        self._pinned_sections: dict[str, Any] = {}
        self._active = False

    def snapshot(self, settings: Any, extra_keys: Iterable[str] = ()) -> None:
        """Remember the protected settings as the runner has set them (and which ones were absent).

        `extra_keys` are further settings the runner has set for this job, for example the options
        of the job. The values are taken as they are now, so they must be set before this call.
        """
        keys = [*PROTECTED_SETTINGS, *(key for key in extra_keys if key not in PROTECTED_SETTINGS)]
        neutralize_unevaluated_values(settings)
        self._pinned = {key: _peek(settings, key) for key in keys}
        self._pinned_sections = {
            section: _peek(settings, section) for section in PROTECTED_SECTIONS
        }
        self._active = True

    def prepare_merge(self, settings: Any) -> None:
        """Called right before a settings file is merged: nothing may be evaluated from now on."""
        if self._active:
            settings.set(AUTO_CAST_SETTING, False)

    def restore(self, settings: Any) -> None:
        # First clean the store of what would make Dynaconf fail on the next read, then the switch:
        # every later `set` of a text goes through Dynaconf's parser.
        neutralize_unevaluated_values(settings)
        settings.set(AUTO_CAST_SETTING, False)
        for section, value in self._pinned_sections.items():
            if value is not _ABSENT:
                settings.set(section, copy.deepcopy(value), merge=False)
            elif _find(settings, section) is not None:
                settings.unset(section, force=True)  # the file added a section that had none
        for key, value in self._pinned.items():
            if value is _ABSENT:
                _forget(settings, key)  # a key PR-Agent does not declare must not appear either
            else:
                settings.set(key, copy.deepcopy(value))
        neutralize_unevaluated_values(settings)


def install_repo_settings_guard(
    utils_module: Any = None,
) -> tuple[RepoSettingsGuard, Callable[[], None]]:
    """Wrap the settings file merge of PR-Agent. Returns the guard and an undo function."""
    if utils_module is None:
        from pr_agent.git_providers import utils as utils_module
    from pr_agent.config_loader import get_settings

    guard = RepoSettingsGuard()
    originals: dict[str, Any] = {}

    def wrap(original: Callable[..., Any]) -> Callable[..., Any]:
        def guarded(*args: Any, **kwargs: Any) -> Any:
            guard.prepare_merge(get_settings())
            try:
                return original(*args, **kwargs)
            finally:
                guard.restore(get_settings())

        return guarded

    for name in _MERGE_FUNCTIONS:
        original = getattr(utils_module, name, None)
        if original is not None:
            originals[name] = original
            setattr(utils_module, name, wrap(original))

    def undo() -> None:
        for name, original in originals.items():
            setattr(utils_module, name, original)

    return guard, undo
