# SPDX-License-Identifier: Apache-2.0

"""The four wire families of the passthrough proxy (#550) and what is allowed for each.

A family is what the pinned engine's bundled SDK speaks to a provider (spike #546, section 4):
OpenAI Chat (and every OpenAI-compatible provider), OpenAI Responses, Anthropic Messages and
Google's Generative Language API. For each there is exactly one request the engine may make: one
method, one path (Google: with the job's model in it), one query, the key in one header and a
closed set of other headers. The engine always streams; no `GET` is needed.

The paths are the engine's own: the proxy's loopback address is the SDK's `baseURL` (`/v1`, for
Google `/v1beta`) and the SDK appends the route. The upstream path is the same route below the job's
trusted base URL, which follows the SDKs' convention (the root they would use as `baseURL`, for
example `https://api.openai.com/v1`).
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Final


class WireFamily(StrEnum):
    """The value is the one of `family` in `contracts/job-model-entry.v1.json`."""

    OPENAI_CHAT = "openai-chat"
    OPENAI_RESPONSES = "openai-responses"
    ANTHROPIC_MESSAGES = "anthropic-messages"
    GOOGLE = "google"


# The SDKs of the pinned engine that speak each family: the pairs of
# `contracts/opencode-providers.v1.json` (#548, derived from the pinned engine's source; a test
# compares them). The entry's `npm` and `family` are checked against each other when the engine's
# configuration is built, so an SDK cannot be pointed at a wire it does not speak.
NPM_OF_FAMILY: Final = {
    WireFamily.OPENAI_CHAT: frozenset(
        {
            "@ai-sdk/openai-compatible",
            "@openrouter/ai-sdk-provider",
            "@ai-sdk/cerebras",
            "@ai-sdk/deepinfra",
            "@ai-sdk/groq",
            "@ai-sdk/mistral",
            "@ai-sdk/perplexity",
            "@ai-sdk/togetherai",
        }
    ),
    WireFamily.OPENAI_RESPONSES: frozenset({"@ai-sdk/openai", "@ai-sdk/xai"}),
    WireFamily.ANTHROPIC_MESSAGES: frozenset({"@ai-sdk/anthropic"}),
    WireFamily.GOOGLE: frozenset({"@ai-sdk/google"}),
}

# The `anthropic-beta` values the pinned engine sends (v1.19.0, docs/spike/544-passthrough.md,
# section 4). A beta changes what a provider does and charges, so any other value is refused.
ALLOWED_ANTHROPIC_BETAS: Final = frozenset(
    {"thinking-binding-controls-2026-08-01", "structured-outputs-2025-11-13"}
)
ALLOWED_ANTHROPIC_VERSIONS: Final = frozenset({"2023-06-01"})

# The headers of the engine besides its key that are forwarded (the rest is dropped, and
# `accept-encoding`, `host`, `connection` and `content-length` are set by the proxy itself).
_COMMON_HEADERS: Final = frozenset(
    {
        "accept",
        "content-type",
        "user-agent",
        "x-opencode-session-id",
        "x-session-id",
        "x-session-affinity",
    }
)
_MESSAGES_HEADERS: Final = _COMMON_HEADERS | {"anthropic-version", "anthropic-beta"}


@dataclass(frozen=True)
class FamilySpec:
    family: WireFamily
    # The header the SDK sends its key in (lower case) and whether the value is a bearer token.
    key_header: str
    bearer: bool
    # The base path of the proxy's loopback URL, and the route the SDK appends to it. Google has the
    # job's model in the route: `route` holds `{model}` for it.
    base_path: str
    route: str
    query: str
    request_headers: frozenset[str]
    # The body fields that carry the output cap, as paths of keys. One of them must be present.
    output_caps: tuple[tuple[str, ...], ...]
    model_in_route: bool = False

    def proxy_base_url(self, proxy_url: str) -> str:
        """The `baseURL` the engine's SDK is given for the proxy at `proxy_url`."""
        return proxy_url.rstrip("/") + self.base_path

    def engine_target(self, model: str) -> str:
        """The request target the engine sends for `model`: path and query."""
        target = self.base_path + self.route.format(model=model)
        return f"{target}?{self.query}" if self.query else target

    def upstream_path(self, model: str) -> str:
        """The same route below the upstream base URL."""
        route = self.route.format(model=model)
        return f"{route}?{self.query}" if self.query else route

    def key_value(self, key: str) -> str:
        """The value of the key header for `key`."""
        return f"Bearer {key}" if self.bearer else key

    def presented_key(self, value: str) -> str | None:
        """The key out of the header value the engine sent, or None when it has the wrong shape."""
        if not self.bearer:
            return value
        if value[:7].lower() != "bearer ":
            return None
        return value[7:]


_SPECS: Final = {
    WireFamily.OPENAI_CHAT: FamilySpec(
        family=WireFamily.OPENAI_CHAT,
        key_header="authorization",
        bearer=True,
        base_path="/v1",
        route="/chat/completions",
        query="",
        request_headers=_COMMON_HEADERS,
        output_caps=(("max_tokens",), ("max_completion_tokens",)),
    ),
    WireFamily.OPENAI_RESPONSES: FamilySpec(
        family=WireFamily.OPENAI_RESPONSES,
        key_header="authorization",
        bearer=True,
        base_path="/v1",
        route="/responses",
        query="",
        request_headers=_COMMON_HEADERS,
        output_caps=(("max_output_tokens",),),
    ),
    WireFamily.ANTHROPIC_MESSAGES: FamilySpec(
        family=WireFamily.ANTHROPIC_MESSAGES,
        key_header="x-api-key",
        bearer=False,
        base_path="/v1",
        route="/messages",
        query="",
        request_headers=_MESSAGES_HEADERS,
        output_caps=(("max_tokens",),),
    ),
    WireFamily.GOOGLE: FamilySpec(
        family=WireFamily.GOOGLE,
        key_header="x-goog-api-key",
        bearer=False,
        base_path="/v1beta",
        route="/models/{model}:streamGenerateContent",
        query="alt=sse",
        request_headers=_COMMON_HEADERS,
        output_caps=(("generationConfig", "maxOutputTokens"),),
        model_in_route=True,
    ),
}


def spec_of(family: WireFamily) -> FamilySpec:
    return _SPECS[family]
