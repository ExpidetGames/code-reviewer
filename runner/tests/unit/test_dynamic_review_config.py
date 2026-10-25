# SPDX-License-Identifier: LicenseRef-Proprietary

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
    BUILTIN_SKILLS_DENIED,
    PROXY_PROVIDER_ID,
    SKILL_TOOL,
    build_engine_config,
    engine_environment,
    permission_block,
)
from code_reviewer_runner.dynamic_review.prompts import compose_system_prompt
from code_reviewer_runner.dynamic_review.repo_skills import SKILL_PATHS
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


# #197-T03, #701-T06
def test_every_tool_but_the_read_only_ones_and_the_skill_loader_is_denied_by_default() -> None:
    permissions = permission_block()

    assert permissions["*"] == "deny"
    for tool in ALLOWED_TOOLS:
        assert permissions[tool] == "allow"
    # The wildcard is what denies a built-in the runner does not know about, including a future one.
    assert set(permissions) == {"*", *ALLOWED_TOOLS, SKILL_TOOL}


# #701-T06
def test_the_skill_loader_is_allowed_for_repository_skills_and_not_for_the_engines_own() -> None:
    skill_rules = permission_block()[SKILL_TOOL]

    # Rules are read last match first: the allow for every name, then the denies of the skills the
    # engine ships itself (a repository skill is the only one the agent is offered).
    assert skill_rules == {"*": "allow", **dict.fromkeys(BUILTIN_SKILLS_DENIED, "deny")}
    assert next(iter(skill_rules)) == "*"
    assert "customize-opencode" in BUILTIN_SKILLS_DENIED
    assert SKILL_TOOL == "skill"


# #197-T03, #701-T06
def test_the_unknown_and_mutating_builtins_are_not_allowed() -> None:
    permissions = permission_block()

    for tool in ("bash", "shell", "edit", "write", "patch", "webfetch", "task", "lsp"):
        assert tool not in permissions or permissions[tool] != "allow"
    # Nothing but the skill loader is a pattern map: no other tool got a finer rule.
    assert [tool for tool, rule in permissions.items() if isinstance(rule, dict)] == [SKILL_TOOL]


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
    assert document["permission"] == permission_block()


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


# #701-T04
def test_the_repository_skill_trees_are_listed_by_the_trusted_config_and_nothing_else_is() -> None:
    document = config()

    # The engine scans these (relative to the export) for `**/SKILL.md`, whatever the discovery
    # flags say; the config is the runner's own, the repository cannot add a path to it.
    assert document["skills"] == {"paths": list(SKILL_PATHS)}
    assert all(not path.startswith("/") and ".." not in path.split("/") for path in SKILL_PATHS)
    # No skill URL: the engine would download from it.
    assert "urls" not in document["skills"]


# #701-T04
def test_the_engine_flags_that_would_reach_outside_the_export_stay_on() -> None:
    environment = engine_environment(
        proxy_url="http://127.0.0.1:41234", home="/job/home", scratch_dir="/job/scratch"
    )

    # Lifting `OPENCODE_DISABLE_CLAUDE_CODE` for `.claude/skills` would also bring back the
    # CLAUDE.md lookup, and lifting `OPENCODE_DISABLE_EXTERNAL_SKILLS` makes the engine walk up
    # from the export; the trees are given by `skills.paths` instead.
    for flag in (
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_PURE",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
    ):
        assert environment[flag] == "true"


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
