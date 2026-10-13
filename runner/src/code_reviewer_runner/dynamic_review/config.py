# SPDX-License-Identifier: Apache-2.0

"""The trusted engine configuration the runner generates for one Dynamic Review (#197).

Nothing here comes from the repository, the claim or the model: the runner writes this file itself
into the job's private directory and hands the engine a minimal, closed environment. The repository
cannot change it, because it is not read from the export.

Two layers, both defence in depth and neither a proof on its own:

- **Permissions** are default-deny before the explicit allows: a caller's own copy shows `read`
  (which also supplies directory listing in this pin), `grep`, `glob` and the non-filesystem
  `StructuredOutput` return. Every other built-in, every unknown and every future tool stays denied.
  The wildcard deny is what makes a new built-in denied by default.
- **Discovery and runtime services** are switched off (plugins, skills, MCP, LSP, formatter,
  watcher, snapshots, sharing, updates, compaction, model fetching). #85 proved these flags are not
  a security boundary on their own — the ESM plugin loader runs repository code despite them — so
  #196 strips every discovery input from the export and this file assumes that happened.

The spike's caveat is binding: the flags are not proof of isolation. They only narrow what a
misconfiguration can reach; the export and the OS boundary of #196/#202 are what actually protect.
"""

import secrets
from typing import Any

# The one provider the engine may talk to: the runner-owned model proxy on loopback. Its key is the
# per-job capability (`new_proxy_capability`), never the workspace credential; the proxy checks it
# on every request and replaces it with the real credential upstream.
PROXY_PROVIDER_ID = "review-proxy"
# 32 random bytes: 256 bits. The proxy refuses anything weaker.
PROXY_CAPABILITY_BYTES = 32


def new_proxy_capability() -> str:
    """A fresh unguessable bearer capability for one job's proxy. Never reused across jobs."""
    return secrets.token_urlsafe(PROXY_CAPABILITY_BYTES)


# The tools the engine may call by name. `read` supplies directory listing in this pin (there is no
# separate `list` tool); `StructuredOutput` is the prompt-loop's own non-filesystem return.
ALLOWED_TOOLS: tuple[str, ...] = ("read", "grep", "glob", "StructuredOutput")

# Environment variables the engine process receives. The engine never sees a GitHub, provider,
# runner or lease credential: its provider is the loopback proxy with a dummy key.
_DISABLED_FLAGS: dict[str, str] = {
    # Stop project config/directory discovery and root instruction lookup. Does not stop nearby
    # rule files attached during a read (the accepted nested-injection risk) and is not a proof.
    "OPENCODE_DISABLE_PROJECT_CONFIG": "true",
    "OPENCODE_DISABLE_CLAUDE_CODE": "true",
    "OPENCODE_DISABLE_EXTERNAL_SKILLS": "true",
    "OPENCODE_PURE": "true",
    "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
    "OPENCODE_DISABLE_MODELS_FETCH": "true",
    "OPENCODE_DISABLE_AUTOUPDATE": "true",
    "OPENCODE_DISABLE_AUTOCOMPACT": "true",
    "OPENCODE_DISABLE_PRUNE": "true",
    "OPENCODE_DISABLE_LSP_DOWNLOAD": "true",
    "OPENCODE_DISABLE_FFF": "true",
    "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true",
    # No package installation, no browser, no telemetry to a discovery service.
    "OPENCODE_DISABLE_EMBEDDED_WEB_UI": "true",
    "OPENCODE_DISABLE_SHARE": "true",
    "DO_NOT_TRACK": "1",
}


def permission_block() -> dict[str, str]:
    """Default-deny permissions with the explicit allows. A new tool is denied by the wildcard."""
    permissions: dict[str, str] = {"*": "deny"}
    for tool in ALLOWED_TOOLS:
        permissions[tool] = "allow"
    return permissions


def build_engine_config(
    *, proxy_url: str, model: str, system_prompt: str, proxy_capability: str
) -> dict[str, Any]:
    """The whole engine configuration for one job, as data the runner writes itself.

    `model` is the operator-configured model identifier; the proxy resolves it to a destination.
    `system_prompt` is the runner-composed trusted prompt (fixed core + review context + skill,
    #198): it is the runner-defined agent's prompt, so the fixed core reaches the model through the
    trusted channel and never through repository instructions or skill discovery. The prepared
    export is not a config key: the adapter scopes every request to it with the directory header.
    `proxy_capability` is the job's bearer capability for the proxy; the config file is the only
    place the engine receives it (never the environment, never the prompt).
    """
    return {
        "permission": permission_block(),
        # The one agent the run may use. The request may not select another; extra built-in agents
        # are not enabled here, and `build`/`plan` are never a safety policy.
        "agent": {
            "review": {
                "description": "Read-only Dynamic Review of one change",
                "mode": "primary",
                "model": f"{PROXY_PROVIDER_ID}/{model}",
                "prompt": system_prompt,
                # No `tools` map: in the pinned release `{"*": false}` removes every tool, the
                # structured-output return included (found against the real binary). The tool
                # set is the permission block above, default-deny.
            }
        },
        # One provider, the loopback proxy. Bundled `@ai-sdk/openai-compatible`, so no package is
        # fetched for an unknown SDK.
        "provider": {
            PROXY_PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Runner model proxy",
                "options": {"baseURL": f"{proxy_url}/v1", "apiKey": proxy_capability},
                "models": {model: {}},
            }
        },
        "enabled_providers": [PROXY_PROVIDER_ID],
        # No repository instruction discovery: the runner composes the prompt (core + skill)
        "instructions": [],
        "plugin": [],
        "mcp": {},
        "lsp": False,
        "formatter": False,
        "snapshot": False,
        "share": "disabled",
        "autoupdate": False,
        "compaction": {"auto": False, "prune": False},
    }


def engine_environment(
    *, proxy_url: str, home: str, scratch_dir: str, node_bin: str | None = None
) -> dict[str, str]:
    """The minimal environment of the engine process.

    Only `PATH` (plus an optional pinned Node runtime), the empty per-job `HOME`, the proxy address
    as the only provider base URL and the disable flags. No `GITHUB_*`, no `OPENROUTER_*`, no runner
    or lease token, no inherited `XDG_*`/config home: an empty home is what keeps global discovery
    out even when a flag is missing.
    """
    environment = dict(_DISABLED_FLAGS)
    environment["HOME"] = home
    environment["XDG_CONFIG_HOME"] = f"{home}/.config"
    environment["XDG_DATA_HOME"] = f"{home}/.local/share"
    environment["XDG_CACHE_HOME"] = f"{home}/.cache"
    environment["XDG_STATE_HOME"] = f"{home}/.local/state"
    environment["TMPDIR"] = scratch_dir
    environment["CI"] = "1"
    environment["NO_COLOR"] = "1"
    environment["OPENCODE_DISABLE_TELEMETRY"] = "true"
    # The engine talks to the proxy only; the proxy is the one that talks upstream.
    environment["REVIEW_PROXY_URL"] = proxy_url
    environment["PATH"] = f"{node_bin}:" if node_bin else ""
    environment["PATH"] += "/usr/local/bin:/usr/bin:/bin"
    return environment
