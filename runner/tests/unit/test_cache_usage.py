# SPDX-License-Identifier: LicenseRef-Proprietary

"""How much of the input of a job came from the provider's cache (#539).

The usage of a call is read in every shape the runner sees: the Messages API after the Anthropic
wire (`cache_read_input_tokens`, `cache_creation_input_tokens`, `prompt_tokens` holding all three),
LiteLLM's `Usage` object, and an OpenAI-shaped answer (OpenRouter) with
`prompt_tokens_details.cached_tokens` and `cache_write_tokens`. The line a job logs holds counts
only."""

from types import SimpleNamespace
from typing import Any

import pytest

from code_reviewer_runner.cache_usage import CacheTally, counts_of


# #539-T16
def test_the_anthropic_shape_after_the_wire_is_read() -> None:
    usage = {
        "prompt_tokens": 1000,
        "cache_read_input_tokens": 700,
        "cache_creation_input_tokens": 200,
        "completion_tokens": 50,
    }
    assert counts_of(usage) == (700, 200, 100)


# #539-T16
def test_litellms_usage_object_is_read() -> None:
    usage = SimpleNamespace(
        prompt_tokens=900, cache_read_input_tokens=600, cache_creation_input_tokens=100
    )
    assert counts_of(usage) == (600, 100, 200)


# #539-T16
def test_an_openai_shaped_answer_with_its_details_is_read() -> None:
    usage = {
        "prompt_tokens": 1000,
        "prompt_tokens_details": {"cached_tokens": 640, "cache_write_tokens": 128},
    }
    assert counts_of(usage) == (640, 128, 232)


# #539-T16
def test_details_given_as_an_object_are_read() -> None:
    usage = SimpleNamespace(
        prompt_tokens=500,
        prompt_tokens_details=SimpleNamespace(cached_tokens=300, cache_creation_tokens=50),
    )
    assert counts_of(usage) == (300, 50, 150)


# #539-T16
def test_the_anthropic_names_win_over_the_details() -> None:
    usage = {
        "prompt_tokens": 1000,
        "cache_read_input_tokens": 400,
        "cache_creation_input_tokens": 100,
        "prompt_tokens_details": {"cached_tokens": 400},
    }
    assert counts_of(usage) == (400, 100, 500)


# #539-T16
def test_a_call_without_cache_fields_is_all_uncached() -> None:
    assert counts_of({"prompt_tokens": 1234, "completion_tokens": 5}) == (0, 0, 1234)


# #539-T16
@pytest.mark.parametrize(
    "usage",
    [
        None,
        {},
        {"prompt_tokens": None},
        {"prompt_tokens": True},
        {"prompt_tokens": -5},
        {"prompt_tokens": "1000"},
        {"prompt_tokens": 100.5},
    ],
)
def test_a_usage_without_a_count_of_prompt_tokens_is_not_counted(usage: Any) -> None:
    assert counts_of(usage) is None


# #539-T16
@pytest.mark.parametrize(
    "usage",
    [
        {"prompt_tokens": 100, "cache_read_input_tokens": -1},
        {"prompt_tokens": 100, "cache_read_input_tokens": True},
        {"prompt_tokens": 100, "cache_read_input_tokens": "9"},
        {"prompt_tokens": 100, "cache_read_input_tokens": 80, "cache_creation_input_tokens": 80},
        {"prompt_tokens": 100, "prompt_tokens_details": {"cached_tokens": 101}},
    ],
)
def test_counts_that_do_not_add_up_are_not_trusted_and_the_call_is_all_uncached(
    usage: dict[str, Any],
) -> None:
    assert counts_of(usage) == (0, 0, 100)


# #539-T16
def test_the_tally_adds_up_the_calls_and_describes_them_in_counts_only() -> None:
    tally = CacheTally()
    tally.add({"prompt_tokens": 1000, "cache_creation_input_tokens": 900})
    tally.add(
        {"prompt_tokens": 1100, "cache_read_input_tokens": 900, "cache_creation_input_tokens": 100}
    )
    tally.add(None)
    tally.add(
        {"prompt_tokens": 1200, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 100}
    )

    assert tally.counts() == (3, 1900, 1100, 300)
    line = tally.describe()
    assert line == (
        "prompt cache: 3 calls, 1900 input tokens read from the cache, "
        "1100 written to the cache, 300 not cached"
    )


# #539-T16
def test_a_tally_of_no_call_says_nothing() -> None:
    tally = CacheTally()
    tally.add(None)
    assert tally.describe() is None
