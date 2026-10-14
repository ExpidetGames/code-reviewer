# SPDX-License-Identifier: Apache-2.0

"""Pins down the trusted engine configuration and the closed environment of one Dynamic Review
(#197).

The repository cannot change either: the runner writes the config itself and hands the engine a
minimal environment. Default-deny permissions, only the read/grep/glob built-ins and the
non-filesystem structured return, one loopback provider, and no credential, home or config discovery
of an inherited environment.
"""

from typing import Any

from code_reviewer_runner.dynamic_review.config import (
    ALLOWED_TOOLS,
    PROXY_PROVIDER_ID,
    build_engine_config,
    engine_environment,
    permission_block,
)
from code_reviewer_runner.dynamic_review.prompts import compose_system_prompt
from code_reviewer_runner.job_loop.jsonvalues import as_object

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
CAPABILITY = "job-capability-0123456789abcdef0123456789abcdef"


def config() -> dict[str, Any]:
    return build_engine_config(
        proxy_url="http://127.0.0.1:41234",
        model="deepseek/deepseek-v4.1-flash",
        system_prompt=compose_system_prompt("look for real bugs", HEAD),
        proxy_capability=CAPABILITY,
    )


# #197-T03
def test_every_tool_but_the_read_only_ones_is_denied_by_default() -> None:
    permissions = permission_block()

    assert permissions["*"] == "deny"
    for tool in ALLOWED_TOOLS:
        assert permissions[tool] == "allow"
    # The wildcard is what denies a built-in the runner does not know about, including a future one.
    assert set(permissions) == {"*", *ALLOWED_TOOLS}


# #197-T03
def test_the_unknown_and_mutating_builtins_are_not_allowed() -> None:
    permissions = permission_block()

    for tool in ("bash", "shell", "edit", "write", "patch", "webfetch", "task", "skill", "lsp"):
        assert tool not in permissions or permissions[tool] != "allow"


# #197-T03
def test_the_config_allows_one_loopback_provider_and_no_other() -> None:
    document = config()

    assert document["enabled_providers"] == [PROXY_PROVIDER_ID]
    providers = as_object(document["provider"])
    assert providers is not None
    assert list(providers) == [PROXY_PROVIDER_ID]
    entry = as_object(providers[PROXY_PROVIDER_ID])
    assert entry is not None
    # The engine never gets a real provider credential: only the per-job proxy capability.
    assert entry["options"] == {"baseURL": "http://127.0.0.1:41234/v1", "apiKey": CAPABILITY}


# #262-T05
def test_a_model_id_with_a_slash_stays_one_model_under_the_runner_provider() -> None:
    document = config()

    # OpenCode reads `provider/model` and splits at the first slash only: the provider is ours and
    # everything after it, slash included, is the model.
    ref = document["agent"]["review"]["model"]
    provider, _, model = ref.partition("/")
    assert (provider, model) == (PROXY_PROVIDER_ID, "deepseek/deepseek-v4.1-flash")
    assert document["provider"][PROXY_PROVIDER_ID]["models"] == {"deepseek/deepseek-v4.1-flash": {}}


# #197-T03
def test_the_config_defines_only_the_review_agent_with_the_trusted_prompt() -> None:
    document = config()
    agent = document["agent"]["review"]

    assert agent["mode"] == "primary"
    assert agent["model"] == f"{PROXY_PROVIDER_ID}/deepseek/deepseek-v4.1-flash"
    assert agent["prompt"] == compose_system_prompt("look for real bugs", HEAD)
    # The agent has no `tools` map: against the real v1.19.0 binary `{"*": false}` removed every
    # tool, StructuredOutput included. The tool set is the default-deny permission block.
    assert "tools" not in agent
    assert all(document["permission"][tool] == "allow" for tool in ALLOWED_TOOLS)


# #197-T02
def test_discovery_and_runtime_services_are_switched_off_in_the_config() -> None:
    document = config()

    assert document["plugin"] == []
    assert document["instructions"] == []
    assert document["mcp"] == {}
    assert document["lsp"] is False
    assert document["formatter"] is False
    assert document["snapshot"] is False
    assert document["share"] == "disabled"
    assert document["autoupdate"] is False
    assert document["compaction"] == {"auto": False, "prune": False}


# #290-T13, #293-T11: OpenCode's own compaction stays off. After a compaction the engine's next
# requests offer no `StructuredOutput` tool and no forced tool choice (the real v1.19.0 binary, see
# docs/dynamic-review.md, "Context window and compaction"), so the run could not return its answer;
# the wrap-up (`wrap_up.py`) relies on the same tool still being registered with the engine.
def test_compaction_and_pruning_stay_off_in_the_config_and_the_environment() -> None:
    document = config()
    environment = engine_environment(
        proxy_url="http://127.0.0.1:41234", home="/job/home", scratch_dir="/job/scratch"
    )

    assert document["compaction"] == {"auto": False, "prune": False}
    assert environment["OPENCODE_DISABLE_AUTOCOMPACT"] == "true"
    assert environment["OPENCODE_DISABLE_PRUNE"] == "true"


# #197-T02
def test_the_engine_environment_is_closed() -> None:
    environment = engine_environment(
        proxy_url="http://127.0.0.1:41234", home="/job/home", scratch_dir="/job/scratch"
    )

    assert environment["HOME"] == "/job/home"
    assert environment["XDG_CONFIG_HOME"] == "/job/home/.config"
    assert environment["TMPDIR"] == "/job/scratch"
    assert environment["OPENCODE_DISABLE_PROJECT_CONFIG"] == "true"
    assert environment["OPENCODE_PURE"] == "true"
    assert environment["OPENCODE_DISABLE_DEFAULT_PLUGINS"] == "true"
    assert environment["OPENCODE_DISABLE_MODELS_FETCH"] == "true"
    assert environment["REVIEW_PROXY_URL"] == "http://127.0.0.1:41234"

    # No credential, no provider token, no runner or lease token, no inherited config directory.
    forbidden = ("TOKEN", "KEY", "SECRET", "PASSWORD", "GITHUB_", "OPENROUTER_", "LEASE")
    for name, value in environment.items():
        assert not any(
            name.upper().startswith(prefix) for prefix in forbidden if prefix.endswith("_")
        ), name
        assert not any(
            name.upper().endswith(prefix) for prefix in forbidden if not prefix.endswith("_")
        ), name
        assert value != ""


# #309-T10: when the engine reaches a step limit it appends a final-step prompt and takes the tools
# away; the run has no such limit, its bounds are the cost limit and the clock (#290).
def test_the_agent_has_no_step_limit_that_could_end_a_turn() -> None:
    agents = as_object(config()["agent"])
    assert agents is not None
    agent = as_object(agents.get("review"))
    assert agent is not None
    assert "steps" not in agent
    assert "maxSteps" not in agent
    assert "steps" not in config()
