# SPDX-License-Identifier: Apache-2.0

"""The scripted upstream and the key swapping relay of the wire fakes (#546), over real sockets.

`fakes/wire/upstream.py` is a provider that only accepts the real key, in the real header, on the
real path; `fakes/wire/relay.py` is the smallest passthrough that stands between an engine holding a
dummy key and that provider. The engine tests of #546 (`test_engine_opencode_native.py`) and the
later passthrough work (#550, #551) stand on both, so their strictness and their faults are pinned
here: a wrong key, a wrong path, a failing status, a stream that is cut, and a relay that
changes nothing but the key.
"""

import gzip
import http.client
import json
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import (
    AUTH_HEADER,
    FAMILIES,
    Family,
    Turn,
    answer,
    auth_value,
    parse_sse,
    request_path,
    stream,
)
from fakes.wire.relay import KeySwapRelay
from fakes.wire.upstream import ScriptedUpstream

MODEL = "acme-model-9"
REAL = "real-key-stand-in-0123456789"
DUMMY = "dummy-capability-0123456789"
TOOL = Turn(tool="read", args={"filePath": "a.py"})
SAY = Turn(text="done")

Reply = tuple[int, dict[str, str], bytes]


def tools_for(family: Family) -> list[dict[str, Any]]:
    if family == "chat":
        return [{"type": "function", "function": {"name": "read"}}]
    if family == "google":
        return [{"functionDeclarations": [{"name": "read"}]}]
    return [{"name": "read"}]


def request(family: Family, *, streaming: bool = True, model: str = MODEL) -> tuple[str, bytes]:
    """The path and body of the chat call of a family, with one tool offered."""
    path = request_path(family, model, streaming=streaming)
    body: dict[str, Any] = {"tools": tools_for(family)}
    if family != "google":
        body["model"] = model
        body["stream"] = streaming
    return path, json.dumps(body).encode()


def send(
    url: str,
    method: str,
    path: str,
    body: bytes | None,
    headers: Mapping[str, str],
) -> Reply:
    parts = urlsplit(url)
    connection = http.client.HTTPConnection(parts.hostname or "", parts.port, timeout=10)
    try:
        connection.request(method, path, body=body, headers=dict(headers))
        response = connection.getresponse()
        data = response.read()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, data
    finally:
        connection.close()


def headers_for(
    family: Family, key: str, *, extra: Mapping[str, str] | None = None
) -> dict[str, str]:
    headers = {"content-type": "application/json", AUTH_HEADER[family]: auth_value(family, key)}
    if family == "messages":
        headers["anthropic-version"] = "2023-06-01"
    headers.update(extra or {})
    return headers


def ask(url: str, family: Family, key: str, **options: Any) -> Reply:
    path, body = request(family, **options)
    return send(url, "POST", path, body, headers_for(family, key))


def upstream(family: Family, *turns: Turn) -> ScriptedUpstream:
    return ScriptedUpstream(family, list(turns) or [SAY], MODEL, real_key=REAL)


@pytest.mark.parametrize("family", FAMILIES)
def test_the_upstream_answers_a_request_with_the_real_key_in_the_header_of_its_family(
    family: Family,
) -> None:
    with upstream(family, TOOL) as server:
        status, headers, data = ask(server.url, family, REAL, streaming=False)

    assert status == 200
    assert json.loads(data) == answer(family, TOOL, 1, MODEL)
    assert headers["content-type"] == "application/json"


# #546-T01
@pytest.mark.parametrize("family", FAMILIES)
def test_the_upstream_refuses_a_key_that_is_not_the_real_one(family: Family) -> None:
    with upstream(family) as server:
        status, _, _ = ask(server.url, family, DUMMY)

    assert status == 401


@pytest.mark.parametrize("family", FAMILIES)
def test_the_upstream_refuses_the_real_key_in_the_header_of_another_family(family: Family) -> None:
    wrong = "x-api-key" if AUTH_HEADER[family] == "authorization" else "authorization"
    value = REAL if wrong == "x-api-key" else f"Bearer {REAL}"
    path, body = request(family)
    headers = {"content-type": "application/json", wrong: value}
    if family == "messages":
        headers["anthropic-version"] = "2023-06-01"

    with upstream(family) as server:
        status, _, _ = send(server.url, "POST", path, body, headers)

    assert status == 401


def test_the_messages_upstream_refuses_a_request_without_the_anthropic_version() -> None:
    path, body = request("messages")
    headers = {"content-type": "application/json", "x-api-key": REAL}

    with upstream("messages") as server:
        status, _, data = send(server.url, "POST", path, body, headers)

    assert status == 400
    assert json.loads(data)["error"]["type"] == "invalid_request_error"


# #546-T09
@pytest.mark.parametrize("family", FAMILIES)
def test_the_upstream_knows_one_path_and_answers_any_other_with_404(family: Family) -> None:
    _, body = request(family)

    with upstream(family) as server:
        status, _, _ = send(server.url, "POST", "/v1/other", body, headers_for(family, REAL))
        listed, _, _ = send(server.url, "GET", "/v1/models", None, headers_for(family, REAL))

    assert (status, listed) == (404, 404)


# #546-T09
def test_the_google_upstream_pins_the_model_in_the_path_and_the_stream_in_the_method() -> None:
    other, body = request("google", model="other-model")
    with upstream("google", SAY) as server:
        elsewhere, _, _ = send(server.url, "POST", other, body, headers_for("google", REAL))
        streamed, _, data = ask(server.url, "google", REAL, streaming=True)
        plain, _, _ = ask(server.url, "google", REAL, streaming=False)

    assert elsewhere == 404
    assert (streamed, plain) == (200, 200)
    assert data == b"".join(stream("google", SAY, 1, MODEL))


@pytest.mark.parametrize("family", ("chat", "responses", "messages"))
def test_the_upstream_refuses_a_model_it_does_not_serve(family: Family) -> None:
    with upstream(family) as server:
        status, _, _ = ask(server.url, family, REAL, model="other-model")

    assert status == 404


@pytest.mark.parametrize("family", FAMILIES)
def test_a_streaming_request_gets_the_events_of_its_family(family: Family) -> None:
    with upstream(family, TOOL) as server:
        status, headers, data = ask(server.url, family, REAL, streaming=True)

    assert status == 200
    assert headers["content-type"] == "text/event-stream"
    assert data == b"".join(stream(family, TOOL, 1, MODEL))
    assert data.count(b"\n\n") == len(stream(family, TOOL, 1, MODEL))


def test_requests_that_offer_tools_take_the_script_in_order_and_others_get_a_short_text() -> None:
    first, second = Turn(tool="read", args={}), Turn(tool="grep", args={})
    path, body = request("chat", streaming=False)
    bare = json.dumps({"model": MODEL, "stream": False}).encode()

    with upstream("chat", first, second, SAY) as server:
        replies = [
            send(server.url, "POST", path, body, headers_for("chat", REAL)) for _ in range(4)
        ]
        title = send(server.url, "POST", path, bare, headers_for("chat", REAL))

    calls = [json.loads(data)["choices"][0]["message"] for _, _, data in replies]
    assert [c["tool_calls"][0]["function"]["name"] for c in calls[:2]] == ["read", "grep"]
    assert calls[2]["content"] == calls[3]["content"] == "done"
    assert json.loads(title[2])["choices"][0]["message"]["content"]


def test_a_failing_status_is_answered_first_and_does_not_use_up_a_turn() -> None:
    with upstream("messages", TOOL) as server:
        server.fail_next(429, 503)
        replies = [ask(server.url, "messages", REAL, streaming=False) for _ in range(3)]

    assert [status for status, _, _ in replies] == [429, 503, 200]
    assert replies[0][1]["retry-after"] == "0"
    assert json.loads(replies[0][2])["error"]["type"] == "rate_limit_error"
    assert json.loads(replies[2][2])["content"][0]["name"] == "read"


def test_a_cut_stream_ends_without_its_last_events_and_the_retry_gets_the_same_turn() -> None:
    with upstream("chat", TOOL) as server:
        server.cut_streams(after_events=2, times=1)
        with pytest.raises(http.client.IncompleteRead):
            ask(server.url, "chat", REAL, streaming=True)
        status, _, data = ask(server.url, "chat", REAL, streaming=True)

    assert status == 200
    assert data == b"".join(stream("chat", TOOL, 1, MODEL))
    assert len(server.records) == 2


def test_the_upstream_compresses_for_a_client_that_accepts_it_when_asked_to() -> None:
    path, body = request("chat", streaming=False)
    headers = headers_for("chat", REAL, extra={"accept-encoding": "gzip"})

    with upstream("chat", SAY) as server:
        server.compress = True
        _, reply_headers, data = send(server.url, "POST", path, body, headers)

    assert reply_headers["content-encoding"] == "gzip"
    assert json.loads(gzip.decompress(data)) == answer("chat", SAY, 1, MODEL)


def test_the_upstream_keeps_every_request_it_received_with_its_headers_and_body() -> None:
    path, body = request("chat", streaming=False)

    with upstream("chat") as server:
        send(server.url, "POST", path, body, headers_for("chat", REAL, extra={"x-extra": "1"}))

    (record,) = server.records
    assert (record.method, record.target) == ("POST", path)
    assert record.headers["x-extra"] == "1"
    assert record.body == json.loads(body)


# -- the relay ----------------------------------------------------------------------------------


@pytest.mark.parametrize("family", FAMILIES)
def test_the_relay_replaces_the_dummy_key_with_the_real_one(family: Family) -> None:
    with (
        upstream(family, TOOL) as server,
        KeySwapRelay(family, server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        status, _, _ = ask(relay.url, family, DUMMY, streaming=True)

    assert status == 200
    (record,) = server.records
    assert record.headers[AUTH_HEADER[family]] == auth_value(family, REAL)
    assert DUMMY not in json.dumps(record.headers)
    (seen,) = relay.seen
    assert seen.headers[AUTH_HEADER[family]] == "<dummy>"
    assert DUMMY not in json.dumps(seen.headers)


def test_the_relay_turns_a_request_without_the_dummy_away_before_the_upstream_sees_it() -> None:
    with (
        upstream("messages") as server,
        KeySwapRelay("messages", server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        real = ask(relay.url, "messages", REAL)
        stranger = ask(relay.url, "messages", "something-else")

    assert real[0] == stranger[0] == 401
    assert server.records == []
    assert [seen.headers["x-api-key"] for seen in relay.seen] == ["<other>", "<other>"]


@pytest.mark.parametrize("family", FAMILIES)
def test_the_relay_hands_on_body_and_answer_byte_for_byte_and_keeps_a_copy_of_the_answer(
    family: Family,
) -> None:
    with (
        upstream(family, TOOL) as server,
        KeySwapRelay(family, server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        status, _, data = ask(relay.url, family, DUMMY, streaming=True)

    assert status == 200
    assert data == b"".join(stream(family, TOOL, 1, MODEL))
    (seen,) = relay.seen
    assert seen.sha256 == server.records[0].sha256
    assert seen.response_bytes == data
    assert seen.status == 200


def test_the_relay_changes_no_header_but_the_key_and_the_hop_by_hop_ones() -> None:
    extra = {
        "anthropic-beta": "thinking-binding-controls-2026-08-01",
        "user-agent": "opencode/1.19.0 test",
        "x-session-id": "ses_1",
        "accept-encoding": "gzip, br",
    }
    path, body = request("messages")

    with (
        upstream("messages") as server,
        KeySwapRelay("messages", server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        send(relay.url, "POST", path, body, headers_for("messages", DUMMY, extra=extra))

    (record,) = server.records
    for name in ("anthropic-version", "anthropic-beta", "user-agent", "x-session-id"):
        assert record.headers[name] == {**extra, "anthropic-version": "2023-06-01"}[name]


# #546-T02
def test_the_relay_asks_the_upstream_for_an_uncompressed_answer_so_that_it_can_read_the_usage() -> (
    None
):
    path, body = request("chat", streaming=False)
    headers = headers_for("chat", DUMMY, extra={"accept-encoding": "gzip, br"})

    with (
        upstream("chat", SAY) as server,
        KeySwapRelay("chat", server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        server.compress = True
        _, _, data = send(relay.url, "POST", path, body, headers)

    assert server.records[0].headers["accept-encoding"] == "identity"
    assert json.loads(data)["usage"]["prompt_tokens"] == 1010


def test_a_relay_that_forwards_accept_encoding_hands_on_compressed_bytes_it_cannot_read() -> None:
    path, body = request("chat", streaming=False)
    headers = headers_for("chat", DUMMY, extra={"accept-encoding": "gzip"})

    with (
        upstream("chat", SAY) as server,
        KeySwapRelay(
            "chat", server.url, dummy_key=DUMMY, real_key=REAL, force_identity=False
        ) as relay,
    ):
        server.compress = True
        send(relay.url, "POST", path, body, headers)

    (seen,) = relay.seen
    assert seen.response_headers["content-encoding"] == "gzip"
    with pytest.raises(ValueError):
        json.loads(seen.response_bytes)


# #546-T07
def test_a_stream_the_upstream_cuts_is_cut_for_the_client_too() -> None:
    with (
        upstream("messages", TOOL) as server,
        KeySwapRelay("messages", server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        server.cut_streams(after_events=3, times=1)
        with pytest.raises(http.client.IncompleteRead):
            ask(relay.url, "messages", DUMMY, streaming=True)

    (seen,) = relay.seen
    assert seen.status == 200
    assert len(parse_sse([seen.response_bytes])) >= 1
    assert not seen.response_bytes.endswith(
        b'event: message_stop\ndata: {"type": "message_stop"}\n\n'
    )


# #546-T07
def test_the_relay_hands_on_an_error_status_and_its_headers() -> None:
    with (
        upstream("chat") as server,
        KeySwapRelay("chat", server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        server.fail_next(429)
        status, headers, data = ask(relay.url, "chat", DUMMY, streaming=True)

    assert status == 429
    assert headers["retry-after"] == "0"
    assert json.loads(data)["error"]["code"] == "429"
