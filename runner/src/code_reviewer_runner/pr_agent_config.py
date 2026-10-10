"""Turns a job into PR-Agent configuration.

PR-Agent reads settings from Dynaconf, which loads every process environment variable with the
shape SECTION__KEY. Two rules decide where a value goes (see the PR-Agent integration note):

- Secrets, URLs and model names go into the environment as strings. The environment wins over a
  repository `.pr_agent.toml`, which is how a repository is kept from redirecting the LLM key or
  the installation token to another host.
- Booleans, integers and lists are typed values set with `get_settings().set()` inside the request
  scope. As environment strings they would arrive as strings, and most checks are plain truthiness
  (the string "false" is truthy).

The returned environment is complete: it replaces the process environment, so nothing of the parent
process (other secrets, stray CONFIG or GITHUB variables) reaches PR-Agent.
"""

from collections.abc import Mapping

from code_reviewer_runner.job import Command, Job

OPENROUTER_API_BASE = "https://openrouter.ai/api/v1"

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


def build_environment(job: Job, parent: Mapping[str, str]) -> dict[str, str]:
    env = {name: parent[name] for name in _PASSTHROUGH if name in parent}
    # The tool options of the job come first and the pins after them. The job validation only
    # lets option keys of the four tools through, so the two sets cannot collide; the order is
    # a second line of defence.
    env.update(job.env)
    model = job.llm.model
    pinned_model = model if model.startswith("openrouter/") else f"openrouter/{model}"
    env.update(
        {
            "CONFIG__GIT_PROVIDER": "github",
            "GITHUB__DEPLOYMENT_TYPE": "user",
            "GITHUB__USER_TOKEN": job.git.token,
            "GITHUB__BASE_URL": job.git.base_url,
            # All three model roles are the job's model: PR-Agent uses the weak model for `ask`
            # and `describe` and the reasoning model for self-reflection, and would otherwise
            # fall back to vendor defaults (and send the LLM key to an unintended model).
            "CONFIG__MODEL": pinned_model,
            "CONFIG__MODEL_WEAK": pinned_model,
            "CONFIG__MODEL_REASONING": pinned_model,
            # An empty value replaces the default fallback model, which belongs to another vendor.
            "CONFIG__FALLBACK_MODELS": "",
            "OPENROUTER__KEY": job.llm.api_key,
            "OPENROUTER__API_BASE": job.llm.base_url or OPENROUTER_API_BASE,
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
            "LITELLM_LOG": "ERROR",
        }
    )
    if job.llm.max_tokens is not None:
        env["CONFIG__CUSTOM_MODEL_MAX_TOKENS"] = str(job.llm.max_tokens)
    return env


def build_typed_settings() -> dict[str, bool | list[str]]:
    """Typed overrides, applied with `get_settings().set(key, value)` before the request."""
    return {
        "config.publish_output": True,
        # No temporary "Preparing review..." comment that is created and deleted again.
        "config.publish_output_progress": False,
        # Settings come from the job, the repository file and the PR-Agent defaults only.
        "config.use_global_settings_file": False,
        "config.output_run_cost": True,
        "config.fallback_models": [],
        # A re-run edits the review in place; no second "updated to latest commit" comment.
        "pr_reviewer.final_update_message": False,
        # Review labels need write scope and surprise users.
        "pr_reviewer.enable_review_labels_security": False,
        "pr_reviewer.enable_review_labels_effort": False,
        "litellm.turn_off_message_logging": True,
    }


def build_request(job: Job) -> list[str]:
    """The `request` argument of `PRAgent.handle_request`, in its list form."""
    if job.command is not Command.ASK:
        return [job.command.value]
    # Imported here: PR-Agent must only be imported after the environment is in place.
    from pr_agent.algo.utils import encode_user_text_arg

    return ["ask", encode_user_text_arg(job.args[0])]
