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
    "config.verbosity_level",
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

# The functions of PR-Agent's git provider utilities that merge a settings file into the settings.
_MERGE_FUNCTIONS = ("_apply_repo_settings_file", "_apply_settings_from_file")


def _waits_for_evaluation(value: object) -> bool:
    """True for Dynaconf's `Lazy` (`@format`, `@jinja`, `@get`, ...) and its meta values."""
    return bool(getattr(value, "_dynaconf_lazy_format", False)) or bool(
        getattr(value, "_meta_value", False)
    )


def _text_of(value: Any) -> str:
    try:
        return str(value._dynaconf_encode())
    except Exception:
        return str(value)


def neutralize_unevaluated_values(settings: Any) -> int:
    """Turn every value that waits for evaluation back into its text; returns how many there were.

    Works on the raw store without going through Dynaconf's parser, which would make the text lazy
    again. Only the number is reported: the names of the keys come from the repository.
    """
    count = 0

    def walk(node: Any) -> None:
        nonlocal count
        if isinstance(node, dict):
            slots: list[tuple[Any, Any]] = list(dict.items(node))  # pyright: ignore
            for key, value in slots:
                if _waits_for_evaluation(value):
                    dict.__setitem__(node, key, _text_of(value))
                    count += 1
                else:
                    walk(value)
        elif isinstance(node, list):
            for index, value in enumerate(list.copy(node)):  # pyright: ignore
                if _waits_for_evaluation(value):
                    list.__setitem__(node, index, _text_of(value))
                    count += 1
                else:
                    walk(value)

    walk(settings.store)
    return count


class RepoSettingsGuard:
    def __init__(self) -> None:
        self._pinned: dict[str, Any] = {}
        self._active = False

    def snapshot(self, settings: Any, extra_keys: Iterable[str] = ()) -> None:
        """Remember the protected settings as the runner has set them (absent ones as None).

        `extra_keys` are further settings the runner has set for this job, for example the options
        of the job. The values are taken as they are now, so they must be set before this call.
        """
        keys = [*PROTECTED_SETTINGS, *(key for key in extra_keys if key not in PROTECTED_SETTINGS)]
        neutralize_unevaluated_values(settings)
        self._pinned = {key: copy.deepcopy(settings.get(key, None)) for key in keys}
        self._active = True

    def prepare_merge(self, settings: Any) -> None:
        """Called right before a settings file is merged: nothing may be evaluated from now on."""
        if self._active:
            settings.set(AUTO_CAST_SETTING, False)

    def restore(self, settings: Any) -> None:
        for key, value in self._pinned.items():
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
