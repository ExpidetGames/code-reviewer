# SPDX-License-Identifier: Apache-2.0

"""A native Dynamic job as the claim sends it (#578): the entry and the cost policy of the chosen
model, and the key of the registry's provider. Not a test file."""

import copy
import json
from typing import Any

from code_reviewer_runner.job import Job, parse_job

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
API_KEY = "dummy-anthropic-key-0123456789"
GIT_TOKEN = "dummy-installation-token-0123456789"
MODEL = "claude-sonnet-5-5"

ENTRY: dict[str, Any] = {
    "version": 1,
    "providerId": "anthropic",
    "npm": "@ai-sdk/anthropic",
    "family": "anthropic-messages",
    "authHeader": "x-api-key",
    "upstreamBaseUrl": "https://api.anthropic.com/v1",
    "modelId": MODEL,
    "model": {
        "name": "Claude Sonnet 5.5",
        "status": "active",
        "tool_call": True,
        "reasoning": False,
        "temperature": True,
        "limit": {"context": 200000, "output": 8192},
        "modalities": {"input": ["text"], "output": ["text"]},
    },
}
CHAT_MODEL = "acme/chat-9"
# The same shape for the registry's other provider, which speaks the chat protocol.
CHAT_ENTRY: dict[str, Any] = {
    **ENTRY,
    "providerId": "openrouter",
    "npm": "@openrouter/ai-sdk-provider",
    "family": "openai-chat",
    "authHeader": "Authorization",
    "upstreamBaseUrl": "https://openrouter.ai/api/v1",
    "modelId": CHAT_MODEL,
}
# The levels of a price book are whole micro-USD per million tokens, as the app writes them.
BOOK: dict[str, Any] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": "6000000",
    "reasoning": None,
    "inputAudio": None,
    "outputAudio": None,
    "contextOver200k": None,
    "tiers": [],
}
MANAGED_COST: dict[str, Any] = {"keyMode": "managed", "priceBook": BOOK, "maxTotalTokens": None}
OWN_COST: dict[str, Any] = {"keyMode": "own", "priceBook": None, "maxTotalTokens": 4_000_000}


def native_document(
    *,
    entry: dict[str, Any] | None = None,
    cost: dict[str, Any] | None = None,
    model: str = MODEL,
    provider: str = "anthropic",
) -> dict[str, Any]:
    return {
        "prUrl": "https://github.com/octo/repo/pull/7",
        "command": "review",
        "reviewKind": "dynamic",
        "dynamic": {
            "model": model,
            "skill": "Look for real bugs.",
            "limits": {"maxFindings": 5},
            "cost": copy.deepcopy(MANAGED_COST if cost is None else cost),
            "modelEntry": copy.deepcopy(ENTRY if entry is None else entry),
        },
        "base": {
            "repository": "octo/repo",
            "baseRef": "main",
            "headSha": HEAD,
            "previousReviewedSha": None,
            "comparison": "full",
        },
        "git": {
            "provider": "github",
            "baseUrl": "https://api.github.com",
            "token": GIT_TOKEN,
            "botLogin": "code-reviewer[bot]",
        },
        "llm": {"provider": provider, "model": model, "apiKey": API_KEY},
    }


def native_job(**options: Any) -> Job:
    return parse_job(json.dumps(native_document(**options)))
