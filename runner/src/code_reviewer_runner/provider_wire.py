# SPDX-License-Identifier: Apache-2.0

"""How the Dynamic proxy speaks to a provider (#511).

The engine always speaks the OpenAI chat protocol to the proxy. A provider that speaks it too
(OpenRouter) needs nothing in between; a provider with a protocol of its own (Anthropic's Messages
API) gets a wire that translates the request the proxy has already checked and the answer it gets
back, so everything after the proxy (the budget ledger, the audit, the wrap-up, the stream the
engine reads) keeps working on one shape: an OpenAI chat completion whose `usage` is what the
provider's cost rule reads.

A wire is built per model (`LlmProviderSpec.wire`), because what a request may carry depends on it.
"""

from typing import Any, Protocol


class UpstreamWire(Protocol):
    def url(self, base: str) -> str:
        """The address of the provider's endpoint for a chat call, from its API base."""
        ...

    def headers(self, api_key: str) -> dict[str, str]:
        """The headers of a call, the credential among them."""
        ...

    def encode_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """The provider's request for a chat request that passed the proxy's allow-list.

        Raises `LimitError` for a request the provider cannot take without changing its meaning.
        """
        ...

    def decode_response(self, body: bytes) -> bytes:
        """The OpenAI chat completion (JSON bytes) for the provider's answer to a 200."""
        ...


class OpenAiChatWire:
    """A provider that speaks the protocol of the engine: nothing is translated."""

    def url(self, base: str) -> str:
        return f"{base}/chat/completions"

    def headers(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    def encode_request(self, request: dict[str, Any]) -> dict[str, Any]:
        return request

    def decode_response(self, body: bytes) -> bytes:
        return body
