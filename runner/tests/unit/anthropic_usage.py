# SPDX-License-Identifier: Apache-2.0

"""The usage of a real Claude Messages API answer for the unit tests (not a test file; #534)."""

import json
from pathlib import Path
from typing import Any

_FIXTURE = (
    Path(__file__).resolve().parents[3] / "fakes" / "fixtures" / "anthropic-message-usage.json"
)


def real_anthropic_usage(
    input_tokens: int = 100, output_tokens: int = 50, **fields: Any
) -> dict[str, Any]:
    """The `usage` of a real Messages API answer with every field it carries, from the fixture the
    fakes share (`fakes/fixtures/anthropic-message-usage.json`, the shape of `Message.usage` in the
    API reference). `fields` replace or add to them.

    The first real Dynamic run failed on `output_tokens_details`, which tests that only built the
    token counts never showed."""
    usage: dict[str, Any] = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    usage.update(input_tokens=input_tokens, output_tokens=output_tokens, **fields)
    return usage
