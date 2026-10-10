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
against this list when the pin changes (see identity_patch.PATCHED_FOR_VERSION).
"""

import copy
from collections.abc import Callable
from typing import Any

# Settings that route a request or a credential, decide which model runs or what a call may cost,
# or switch publishing and callbacks. Dotted names as used by Dynaconf's `get` and `set`.
PROTECTED_SETTINGS = (
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


class RepoSettingsGuard:
    def __init__(self) -> None:
        self._pinned: dict[str, Any] = {}

    def snapshot(self, settings: Any) -> None:
        """Remember the protected settings as the runner has set them (absent ones as None)."""
        self._pinned = {key: copy.deepcopy(settings.get(key, None)) for key in PROTECTED_SETTINGS}

    def restore(self, settings: Any) -> None:
        for key, value in self._pinned.items():
            settings.set(key, copy.deepcopy(value))


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
