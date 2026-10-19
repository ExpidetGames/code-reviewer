# SPDX-License-Identifier: Apache-2.0

"""The Anthropic (Claude API) model list of the runner (#511): ids, limits, the flags that decide
which request parameters a model takes, and the prices that every call is costed with.

This is the runner's typed copy of `contracts/anthropic-models.v1.json`, which is also the source of
the app's list (`app/src/llm/providers/anthropic/models.ts`). A test compares the three, so the app
that lets a person pick a model and the runner that prices its calls cannot disagree. Read on
2026-10-19 from https://platform.claude.com/docs/en/about-claude/pricing,
.../models/overview and .../model-deprecations (more sources in the contract file). Prices are
USD per million tokens, kept as `Decimal` so no float rounding enters a charge.

**The flags decide, not the name.** `temperature`, `top_p`, `forced_tool_choice` and
`thinking_disabled` say what a request to the model may carry. Nothing derives them from an id: a
model that is not in the list has no flags, so the callers send it no sampling parameter, and its
calls cost an unknown amount.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Final

AS_OF: Final = "2026-10-19"


@dataclass(frozen=True)
class Prices:
    """USD per million tokens."""

    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write_5m: Decimal
    cache_write_1h: Decimal


def prices(
    input: str, output: str, cache_read: str, cache_write_5m: str, cache_write_1h: str
) -> Prices:
    return Prices(
        Decimal(input),
        Decimal(output),
        Decimal(cache_read),
        Decimal(cache_write_5m),
        Decimal(cache_write_1h),
    )


@dataclass(frozen=True)
class LongPrompt:
    """Higher prices for a request whose prompt (input, cache reads and cache writes together) is
    over `over_input_tokens`. Each request is priced on its own."""

    over_input_tokens: int
    prices: Prices


@dataclass(frozen=True)
class ClaudeModel:
    id: str
    display_name: str
    context_window_tokens: int
    max_output_tokens: int
    retires_not_before: str
    # A non-default `temperature` / `top_p` is accepted (a 400 from Opus 4.7 on). Never both.
    temperature: bool
    top_p: bool
    tools: bool
    # `tool_choice` `any` or a named tool is accepted (a 400 on Fable 5.1, Opus 5.5 and Sonnet
    # 5.5, which the Dynamic wire steers with `auto`, #533).
    forced_tool_choice: bool
    # `thinking: {"type": "disabled"}` is accepted at the model's default effort. A model without
    # it always thinks: the Dynamic wire steers it and carries its thinking blocks (#533).
    thinking_disabled: bool
    review_kinds: tuple[str, ...]
    prices: Prices
    long_prompt: LongPrompt | None


MODELS: Final[dict[str, ClaudeModel]] = {
    model.id: model
    for model in (
        ClaudeModel(
            id="claude-fable-5-1",
            display_name="Claude Fable 5.1",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-09-01",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=False,
            thinking_disabled=False,
            review_kinds=("diff", "dynamic"),
            prices=prices("10", "50", "0.25", "12.50", "20"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-opus-5-5",
            display_name="Claude Opus 5.5",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-09-22",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=False,
            thinking_disabled=False,
            review_kinds=("diff", "dynamic"),
            prices=prices("4", "20", "0.20", "5", "8"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-sonnet-5-5",
            display_name="Claude Sonnet 5.5",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-09-28",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=False,
            thinking_disabled=False,
            review_kinds=("diff", "dynamic"),
            prices=prices("2", "10", "0.10", "2.50", "4"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-haiku-5-5",
            display_name="Claude Haiku 5.5",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-10-07",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("0.10", "0.50", "0.01", "0.125", "0.20"),
            long_prompt=LongPrompt(
                over_input_tokens=100000, prices=prices("0.50", "2.50", "0.05", "0.625", "1")
            ),
        ),
        ClaudeModel(
            id="claude-fable-5",
            display_name="Claude Fable 5",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-06-09",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=False,
            review_kinds=("diff", "dynamic"),
            prices=prices("10", "50", "1", "12.50", "20"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-opus-5",
            display_name="Claude Opus 5",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-07-24",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("5", "25", "0.50", "6.25", "10"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-opus-4-8",
            display_name="Claude Opus 4.8",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-05-28",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("5", "25", "0.50", "6.25", "10"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-opus-4-7",
            display_name="Claude Opus 4.7",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-04-16",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("5", "25", "0.50", "6.25", "10"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-opus-4-6",
            display_name="Claude Opus 4.6",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-02-05",
            temperature=True,
            top_p=True,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("5", "25", "0.50", "6.25", "10"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-opus-4-5-20251101",
            display_name="Claude Opus 4.5",
            context_window_tokens=200000,
            max_output_tokens=64000,
            retires_not_before="2026-11-24",
            temperature=True,
            top_p=True,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("5", "25", "0.50", "6.25", "10"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-sonnet-5",
            display_name="Claude Sonnet 5",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-06-30",
            temperature=False,
            top_p=False,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("2", "10", "0.20", "2.50", "4"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-sonnet-4-6",
            display_name="Claude Sonnet 4.6",
            context_window_tokens=1000000,
            max_output_tokens=128000,
            retires_not_before="2027-02-17",
            temperature=True,
            top_p=True,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("3", "15", "0.30", "3.75", "6"),
            long_prompt=None,
        ),
        ClaudeModel(
            id="claude-haiku-4-5-20251001",
            display_name="Claude Haiku 4.5",
            context_window_tokens=200000,
            max_output_tokens=64000,
            retires_not_before="2026-10-15",
            temperature=True,
            top_p=True,
            tools=True,
            forced_tool_choice=True,
            thinking_disabled=True,
            review_kinds=("diff", "dynamic"),
            prices=prices("1", "5", "0.10", "1.25", "2"),
            long_prompt=None,
        ),
    )
}

DEFAULT_MODELS: Final = {"diff": "claude-haiku-5-5", "dynamic": "claude-sonnet-5-5"}


def model_for(model_id: str) -> ClaudeModel | None:
    """The model with exactly this id (no alias, no prefix, no case folding), or None."""
    return MODELS.get(model_id)
