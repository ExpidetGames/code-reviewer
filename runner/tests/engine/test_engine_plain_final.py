# SPDX-License-Identifier: Apache-2.0

"""Finalization above the wire with the real pinned OpenCode (#552, spike #547).

The production adapter (`DynamicEngine(plain_final=True)`) drives the stock engine with no `format`,
behind the production passthrough proxy and ledger and the strict Messages fake of `fakes/wire`. The
mechanics are proven for one family; how well each real model follows the instruction is a live
question (`docs/spike/547-plain-json-final.md`, section 7). An engine start costs about five
seconds, so the cases are few and each is a whole run.
"""

import itertools
from pathlib import Path
from typing import Any

import pytest
from fakes.wire.formats import Turn
from opencode_support import opencode_binary
from plain_final_support import native_run, reads, review, tool_names

pytestmark = pytest.mark.engine

TOOLS = {"read", "grep", "glob"}


@pytest.fixture(autouse=True)
def pinned_engine_is_installed() -> None:
    assert opencode_binary().is_file()


def uncached(value: Any) -> Any:
    """The content without its cache breakpoints, which the engine moves to the newest messages."""
    if isinstance(value, dict):
        return {key: uncached(item) for key, item in value.items() if key != "cache_control"}  # pyright: ignore[reportUnknownVariableType]
    if isinstance(value, list):
        return [uncached(item) for item in value]  # pyright: ignore[reportUnknownVariableType]
    return value


def assert_same_prefix(requests: list[dict[str, Any]]) -> None:
    """Each call is the previous call's whole conversation and something more: the tools, the
    model and every earlier message are identical, so a provider caches the prefix."""
    for earlier, later in itertools.pairwise(requests):
        before, after = uncached(earlier["messages"]), uncached(later["messages"])
        assert after[: len(before)] == before
        for key in ("tools", "model", "max_tokens", "system"):
            assert uncached(later.get(key)) == uncached(earlier.get(key)), key


# #552-T10, #552-T08, #552-T01: a full review ends with valid JSON text and nothing structured
def test_a_full_review_ends_with_valid_json_text_and_no_request_asks_for_a_format(
    tmp_path: Path,
) -> None:
    with native_run(tmp_path, lambda export: [*reads(export, 3), Turn(text=review())]) as run:
        assert run.answer.ok, run.answer.error
        assert run.answer.findings is not None
        assert run.answer.findings.reviewed_sha == "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
        assert len(run.requests) == 4
        for request in run.requests:
            assert tool_names(request) == TOOLS
            assert request.get("tool_choice") in (None, {"type": "auto"})
            assert "StructuredOutput" not in str(request)
            assert not {"response_format", "output_config", "output_format"} & request.keys()
        assert_same_prefix(run.requests)
        # The audit of the native path saw the engine's tool parts on its event stream.
        assert run.ledger.tool_calls == 3
        assert run.ledger.returned_bytes > 0
        assert run.ledger.files >= 1
        assert run.ledger.failure is None
        assert run.ledger.usage(None).stopped_early is None
