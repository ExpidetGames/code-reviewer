# SPDX-License-Identifier: Apache-2.0

"""The tee of the passthrough proxy (#550): SSE framing, the usage read from the bytes, the price of
a call, and the redaction of an answer that quotes the key.

The parsers here are the minimal ones (#551 hardens them against captured answers); what is pinned
is the interface the relay needs and the places the generic fakes of `fakes/wire` put the usage.
"""

import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Family, Turn, answer, error_event, stream, usage_for

from code_reviewer_runner.dynamic_review.budget import UnitCosts
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.dynamic_review.passthrough.pricing import call_cost
from code_reviewer_runner.dynamic_review.passthrough.redact import Redactor
from code_reviewer_runner.dynamic_review.passthrough.sse import SseFramer, read_event
from code_reviewer_runner.dynamic_review.passthrough.usage import CallUsage, tap_for

KEY = "sk-real-key-0123456789abcdefABCDEF"
MODEL = "acme-model-9"
FAKE_FAMILY: dict[WireFamily, Family] = {
    WireFamily.OPENAI_CHAT: "chat",
    WireFamily.OPENAI_RESPONSES: "responses",
    WireFamily.ANTHROPIC_MESSAGES: "messages",
    WireFamily.GOOGLE: "google",
}
FAMILIES = list(WireFamily)
TURN = Turn(tool="read", args={"filePath": "/x"})


def usage_expected(call: int, family: WireFamily) -> CallUsage:
    """What the fakes state for `call`, as the runner counts it: the prompt includes the cache."""
    u = usage_for(call)
    if family is WireFamily.ANTHROPIC_MESSAGES:
        writes = u.cache_write_5m + u.cache_write_1h
        return CallUsage(u.input + u.cache_read + writes, u.output, u.cache_read, writes, None)
    if family is WireFamily.GOOGLE:
        return CallUsage(u.input, u.output + u.reasoning, u.cache_read, 0, None)
    return CallUsage(u.input, u.output, u.cache_read, 0, None)


# -- redaction -----------------------------------------------------------------------------------


# #550-T10
def test_the_key_and_every_long_part_of_it_are_cut_out() -> None:
    redactor = Redactor(KEY)
    quoted = (
        f'{{"error": "invalid key {KEY}", "header": "Bearer {KEY}", '
        f'"masked": "{KEY[:12]}...{KEY[-10:]}", "again": "{KEY}"}}'
    ).encode()
    redacted = redactor.redact(quoted)
    assert KEY.encode() not in redacted
    assert KEY[:12].encode() not in redacted
    assert KEY[-10:].encode() not in redacted
    assert redacted.count(b"[redacted]") >= 4
    assert json.loads(redacted)["error"].startswith("invalid key")


# #550-T10
def test_an_answer_that_has_nothing_of_the_key_is_returned_as_it_is() -> None:
    redactor = Redactor(KEY)
    plain = b'data: {"choices": [{"delta": {"content": "sk-ip it and read 0123"}}]}\n\n'
    assert redactor.redact(plain) is plain
    # Seven characters of the key are not enough to be a part of it.
    assert redactor.redact(KEY[3:10].encode()) == KEY[3:10].encode()


# #550-T10
def test_a_short_key_is_cut_out_whole_and_nothing_else() -> None:
    redactor = Redactor("abc12345")
    assert redactor.redact(b"key abc12345 and abc1234 and bc12345") == (
        b"key [redacted] and abc1234 and bc12345"
    )


# -- server-sent events --------------------------------------------------------------------------


def events_of(family: WireFamily, *, crlf: bool = False, call: int = 1) -> list[bytes]:
    return stream(FAKE_FAMILY[family], TURN, call, MODEL, crlf=crlf)


# #550-T08
@pytest.mark.parametrize("crlf", [False, True])
@pytest.mark.parametrize("size", [1, 2, 3, 7, 64, 10_000])
def test_events_are_framed_at_any_chunk_boundary_and_no_byte_is_lost(crlf: bool, size: int) -> None:
    whole = b"".join(events_of(WireFamily.ANTHROPIC_MESSAGES, crlf=crlf))
    framer = SseFramer()
    framed: list[bytes] = []
    for at in range(0, len(whole), size):
        framed += framer.feed(whole[at : at + size])
    rest = framer.finish()
    assert rest == b""
    assert b"".join(framed) == whole
    assert len(framed) == len(events_of(WireFamily.ANTHROPIC_MESSAGES))
    assert all(event.endswith((b"\n\n", b"\r\n\r\n")) for event in framed)


# #550-T08
def test_an_unfinished_event_is_kept_until_it_is_finished() -> None:
    framer = SseFramer()
    assert framer.feed(b"event: a\ndata: {") == []
    assert framer.feed(b'"x": 1}\n') == []
    assert framer.feed(b"\n") == [b'event: a\ndata: {"x": 1}\n\n']
    assert framer.feed(b"data: tail") == []
    assert framer.finish() == b"data: tail"


# #550-T08
def test_an_event_has_a_name_and_its_data_lines_joined() -> None:
    event = read_event(b': comment\nevent: message_start\ndata: {"a":\ndata: 1}\n\n')
    assert event.name == "message_start"
    assert event.data == '{"a":\n1}'
    assert read_event(b"data: [DONE]\r\n\r\n").data == "[DONE]"


# -- the usage tap -------------------------------------------------------------------------------


def read_stream(family: WireFamily, events: list[bytes], *, sizes: int = 0):  # type: ignore[no-untyped-def]
    tap = tap_for(family, sse=True)
    whole = b"".join(events)
    step = sizes or len(whole)
    for at in range(0, len(whole), step):
        tap.feed(whole[at : at + step])
    return tap.finish()


# #550-T08
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("rechunk", [0, 5])
def test_the_usage_of_a_stream_is_read_from_the_bytes_of_each_family(
    family: WireFamily, rechunk: int
) -> None:
    result = read_stream(family, events_of(family, call=3), sizes=rechunk)
    assert result.usage == usage_expected(3, family)
    assert result.terminated
    assert not result.errored


# #550-T08
def test_google_takes_the_last_usage_of_a_stream_that_states_it_on_every_chunk() -> None:
    events = stream("google", TURN, 4, MODEL, cumulative_usage=True)
    result = read_stream(WireFamily.GOOGLE, events)
    assert result.usage == usage_expected(4, WireFamily.GOOGLE)


# #550-T08
@pytest.mark.parametrize("family", FAMILIES)
def test_the_usage_of_a_plain_answer_is_read_as_well(family: WireFamily) -> None:
    tap = tap_for(family, sse=False)
    body = json.dumps(answer(FAKE_FAMILY[family], TURN, 2, MODEL)).encode()
    tap.feed(body[:50])
    tap.feed(body[50:])
    result = tap.finish()
    assert result.usage == usage_expected(2, family)
    assert result.terminated and not result.errored


# #550-T06
def test_a_chat_stream_without_the_usage_chunk_has_no_usage() -> None:
    events = stream("chat", TURN, 1, MODEL, include_usage=False)
    result = read_stream(WireFamily.OPENAI_CHAT, events)
    assert result.usage is None
    assert result.terminated


# #550-T06
def test_a_charge_the_provider_states_is_kept() -> None:
    usage = {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.0012}
    chunk: dict[str, object] = {"choices": [], "usage": usage}
    body = f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode()
    result = read_stream(WireFamily.OPENAI_CHAT, [body])
    assert result.usage == CallUsage(10, 5, 0, 0, Decimal("0.0012"))


# #550-T06
@pytest.mark.parametrize(
    "usage",
    [
        {"prompt_tokens": -1, "completion_tokens": 5},
        {"prompt_tokens": True, "completion_tokens": 5},
        {"prompt_tokens": "10", "completion_tokens": 5},
        {"prompt_tokens": 10},
        {},
    ],
)
def test_a_usage_that_is_not_made_of_counts_is_no_usage(usage: dict[str, object]) -> None:
    body = f"data: {json.dumps({'choices': [], 'usage': usage})}\n\ndata: [DONE]\n\n".encode()
    assert read_stream(WireFamily.OPENAI_CHAT, [body]).usage is None


# #550-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_an_error_event_in_a_stream_is_seen(family: WireFamily) -> None:
    events = [*events_of(family)[:2], error_event(FAKE_FAMILY[family])]
    result = read_stream(family, events)
    assert result.errored
    assert not result.terminated


# #550-T09
def test_the_input_of_a_messages_call_that_failed_later_is_stated_but_not_complete() -> None:
    events = [*events_of(WireFamily.ANTHROPIC_MESSAGES, call=5)[:3], error_event("messages")]
    result = read_stream(WireFamily.ANTHROPIC_MESSAGES, events)
    assert result.errored and not result.terminated
    # `message_start` stated the input and the cache, with a placeholder output of 1 token: it is
    # visible (for the trace) and it is not a usage to settle with.
    assert result.usage is not None
    assert (
        result.usage.prompt_tokens == usage_expected(5, WireFamily.ANTHROPIC_MESSAGES).prompt_tokens
    )
    assert result.usage.completion_tokens == 1


# #550-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_that_stops_before_its_end_is_not_terminated(family: WireFamily) -> None:
    result = read_stream(family, events_of(family)[:1])
    assert not result.terminated


# #550-T09
def test_an_error_object_in_a_plain_answer_is_an_error() -> None:
    tap = tap_for(WireFamily.OPENAI_CHAT, sse=False)
    tap.feed(b'{"error": {"message": "overloaded"}}')
    result = tap.finish()
    assert result.errored and result.usage is None


# -- the price of a call -------------------------------------------------------------------------

PRICES = UnitCosts(
    input_usd_per_mtok=Decimal(3),
    output_usd_per_mtok=Decimal(15),
    cache_read_usd_per_mtok=Decimal("0.3"),
    cache_write_usd_per_mtok=Decimal("3.75"),
)


# #550-T11
def test_a_call_costs_its_fresh_input_its_cache_reads_and_writes_and_its_output() -> None:
    usage = CallUsage(1000, 20, 300, 100, None)
    # 600 fresh * 3 + 300 read * 0.3 + 100 written * 3.75 + 20 out * 15, per million tokens.
    assert call_cost(usage, PRICES) == Decimal("0.002565")


# #550-T11
def test_a_cache_read_without_a_read_price_is_priced_as_input_and_a_write_has_no_price() -> None:
    plain = UnitCosts(input_usd_per_mtok=Decimal(3), output_usd_per_mtok=Decimal(15))
    assert call_cost(CallUsage(1000, 20, 300, 0, None), plain) == Decimal("0.0033")
    # Priced as input it would be cheaper than it is, so the cost is unknown instead.
    assert call_cost(CallUsage(1000, 20, 300, 100, None), plain) is None


# #550-T11
def test_the_charge_a_provider_states_is_the_cost() -> None:
    usage = CallUsage(1000, 20, 0, 0, Decimal("0.5"))
    assert call_cost(usage, PRICES) == Decimal("0.5")


# #550-T11
def test_cache_counts_that_do_not_fit_the_prompt_are_priced_as_plain_input() -> None:
    assert call_cost(CallUsage(100, 10, 90, 90, None), PRICES) == Decimal("0.00045")
