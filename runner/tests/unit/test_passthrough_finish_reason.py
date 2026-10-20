# SPDX-License-Identifier: Apache-2.0

"""Why a call ended, read from the provider's own answer (#578, finding of the security review).

The usage tap also says the finish of the call, in the words of the chat protocol the call trace
allows (`stop`, `tool_calls`, `length`, `content_filter`): the finalization line of a native run and
its trace could not say `finish=length` before, the proxy noted `None` for every call. Only the
provider's structure counts (`stop_reason`, `finish_reason`, `status`, `finishReason`), never a word
of the model.
"""

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import Turn, answer, stream
from passthrough_support import FAKE, MODEL

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.usage import TapResult, tap_for

CHAT, RESPONSES, MESSAGES, GOOGLE = list(WireFamily)
TEXT = Turn(text="the review")
TOOL = Turn(tool="read", args={"filePath": "/x"})


def read_stream(family: WireFamily, chunks: list[bytes]) -> TapResult:
    tap = tap_for(family, sse=True)
    for chunk in chunks:
        tap.feed(chunk)
    return tap.finish()


def read_document(family: WireFamily, document: Any) -> TapResult:
    tap = tap_for(family, sse=False)
    tap.feed(json.dumps(document).encode())
    return tap.finish()


# #578-T19
@pytest.mark.parametrize(
    ("family", "turn", "expected"),
    [
        (CHAT, Turn(text="x"), "stop"),
        (CHAT, Turn(text="x", finish="length"), "length"),
        (CHAT, Turn(text="x", finish="content_filter"), "content_filter"),
        (CHAT, TOOL, "tool_calls"),
        (MESSAGES, Turn(text="x"), "stop"),
        (MESSAGES, Turn(text="x", finish="max_tokens"), "length"),
        (MESSAGES, Turn(text="x", finish="refusal"), "content_filter"),
        (MESSAGES, TOOL, "tool_calls"),
    ],
)
def test_a_chat_or_messages_call_says_why_it_ended(
    family: WireFamily, turn: Turn, expected: str
) -> None:
    streamed = read_stream(family, stream(FAKE[family], turn, 1, MODEL))
    whole = read_document(family, answer(FAKE[family], turn, 1, MODEL))

    assert streamed.finish_reason == expected
    assert whole.finish_reason == expected


# #578-T19
def test_a_responses_call_that_ran_out_of_output_ended_with_length() -> None:
    finished = answer("responses", TEXT, 1, MODEL)
    cut = {
        **finished,
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
    }
    filtered = {
        **finished,
        "status": "incomplete",
        "incomplete_details": {"reason": "content_filter"},
    }

    assert read_document(RESPONSES, finished).finish_reason == "stop"
    assert read_document(RESPONSES, cut).finish_reason == "length"
    assert read_document(RESPONSES, filtered).finish_reason == "content_filter"


# #578-T19
def test_a_responses_stream_says_why_it_ended_at_its_last_event() -> None:
    chunks = stream("responses", TEXT, 1, MODEL)
    assert read_stream(RESPONSES, chunks).finish_reason == "stop"

    *head, last = chunks
    document = json.loads(last.decode().split("data: ", 1)[1])
    document["type"] = "response.incomplete"
    document["response"]["status"] = "incomplete"
    document["response"]["incomplete_details"] = {"reason": "max_output_tokens"}
    cut = b"event: response.incomplete\ndata: " + json.dumps(document).encode() + b"\n\n"

    assert read_stream(RESPONSES, [*head, cut]).finish_reason == "length"


# #578-T19
@pytest.mark.parametrize(
    ("reason", "expected"),
    [("STOP", "stop"), ("MAX_TOKENS", "length"), ("SAFETY", "content_filter")],
)
def test_a_google_call_says_why_it_ended(reason: str, expected: str) -> None:
    whole = answer("google", TEXT, 1, MODEL)
    whole["candidates"][0]["finishReason"] = reason
    streamed = stream("google", TEXT, 1, MODEL)
    last = json.loads(streamed[-1].decode().split("data: ", 1)[1])
    last["candidates"][0]["finishReason"] = reason
    streamed[-1] = b"data: " + json.dumps(last).encode() + b"\n\n"

    assert read_document(GOOGLE, whole).finish_reason == expected
    assert read_stream(GOOGLE, streamed).finish_reason == expected


# #578-T19
def test_a_stream_without_a_finish_has_none() -> None:
    for family in WireFamily:
        cut = stream(FAKE[family], TEXT, 1, MODEL)[:1]

        assert read_stream(family, cut).finish_reason is None


# #578-T19
def test_a_reason_the_runner_does_not_know_is_other_and_never_a_stop() -> None:
    chat = answer("chat", TEXT, 1, MODEL)
    chat["choices"][0]["finish_reason"] = "brand_new_reason"
    messages = answer("messages", TEXT, 1, MODEL)
    messages["stop_reason"] = "brand_new_reason"
    google = answer("google", TEXT, 1, MODEL)
    google["candidates"][0]["finishReason"] = "BRAND_NEW_REASON"
    responses = answer("responses", TEXT, 1, MODEL)
    responses["status"] = "incomplete"
    responses["incomplete_details"] = {"reason": "brand_new_reason"}

    assert read_document(CHAT, chat).finish_reason == "other"
    assert read_document(MESSAGES, messages).finish_reason == "other"
    assert read_document(GOOGLE, google).finish_reason == "other"
    assert read_document(RESPONSES, responses).finish_reason == "other"
