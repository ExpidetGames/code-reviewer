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
        model="deepseek-v4.1-flash",
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


# #197-T03
def test_the_config_defines_only_the_review_agent_with_the_trusted_prompt() -> None:
    document = config()
    agent = document["agent"]["review"]

    assert agent["mode"] == "primary"
    assert agent["model"] == f"{PROXY_PROVIDER_ID}/deepseek-v4.1-flash"
    assert agent["prompt"] == compose_system_prompt("look for real bugs", HEAD)
    assert agent["tools"]["*"] is False
    assert all(agent["tools"][tool] is True for tool in ALLOWED_TOOLS)


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
