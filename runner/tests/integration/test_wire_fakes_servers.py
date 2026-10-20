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
import socket
import sys
import threading
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
    if family == "chat" and streaming:
        body["stream_options"] = {"include_usage": True}  # what the engine sends
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


def raw_chunks(url: str, path: str, body: bytes, headers: Mapping[str, str]) -> list[bytes]:
    """The HTTP chunks of a chunked answer, as they were framed on the wire."""
    parts = urlsplit(url)
    head = [f"POST {path} HTTP/1.1", f"Host: {parts.hostname}:{parts.port}", "Connection: close"]
    head += [f"{name}: {value}" for name, value in headers.items()]
    head.append(f"Content-Length: {len(body)}")
    with socket.create_connection((parts.hostname or "", parts.port or 0), timeout=10) as sock:
        sock.sendall(("\r\n".join(head) + "\r\n\r\n").encode() + body)
        raw = b""
        while data := sock.recv(65536):
            raw += data
    rest = raw.split(b"\r\n\r\n", 1)[1]
    chunks: list[bytes] = []
    while rest:
        size_line, rest = rest.split(b"\r\n", 1)
        size = int(size_line, 16)
        if size == 0:
            break
        chunks.append(rest[:size])
        rest = rest[size + 2 :]
    return chunks


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


# #546-T01
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


# #546-T01
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


# #546-T01
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


# #546-T03
@pytest.mark.parametrize("family", ("chat", "responses", "messages"))
def test_the_upstream_refuses_a_model_it_does_not_serve(family: Family) -> None:
    with upstream(family) as server:
        status, _, _ = ask(server.url, family, REAL, model="other-model")

    assert status == 404


# #546-T02
@pytest.mark.parametrize("family", FAMILIES)
def test_a_streaming_request_gets_the_events_of_its_family(family: Family) -> None:
    with upstream(family, TOOL) as server:
        status, headers, data = ask(server.url, family, REAL, streaming=True)

    assert status == 200
    assert headers["content-type"] == "text/event-stream"
    assert data == b"".join(stream(family, TOOL, 1, MODEL))
    assert data.count(b"\n\n") == len(stream(family, TOOL, 1, MODEL))


# #546-T02
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


# #546-T07
def test_a_failing_status_is_answered_first_and_does_not_use_up_a_turn() -> None:
    with upstream("messages", TOOL) as server:
        server.fail_next(429, 503)
        replies = [ask(server.url, "messages", REAL, streaming=False) for _ in range(3)]

    assert [status for status, _, _ in replies] == [429, 503, 200]
    assert replies[0][1]["retry-after"] == "0"
    assert json.loads(replies[0][2])["error"]["type"] == "rate_limit_error"
    assert json.loads(replies[2][2])["content"][0]["name"] == "read"


# #546-T07
def test_a_cut_stream_ends_without_its_last_events_and_the_retry_gets_the_same_turn() -> None:
    with upstream("chat", TOOL) as server:
        server.cut_streams(after_events=2, times=1)
        with pytest.raises(http.client.IncompleteRead):
            ask(server.url, "chat", REAL, streaming=True)
        status, _, data = ask(server.url, "chat", REAL, streaming=True)

    assert status == 200
    assert data == b"".join(stream("chat", TOOL, 1, MODEL))
    assert len(server.records) == 2


# #546-T02
def test_the_upstream_compresses_for_a_client_that_accepts_it_when_asked_to() -> None:
    path, body = request("chat", streaming=False)
    headers = headers_for("chat", REAL, extra={"accept-encoding": "gzip"})

    with upstream("chat", SAY) as server:
        server.compress = True
        _, reply_headers, data = send(server.url, "POST", path, body, headers)

    assert reply_headers["content-encoding"] == "gzip"
    assert json.loads(gzip.decompress(data)) == answer("chat", SAY, 1, MODEL)


# #546-T08
def test_the_upstream_keeps_every_request_it_received_with_its_headers_and_body() -> None:
    path, body = request("chat", streaming=False)

    with upstream("chat") as server:
        send(server.url, "POST", path, body, headers_for("chat", REAL, extra={"x-extra": "1"}))

    (record,) = server.records
    assert (record.method, record.target) == ("POST", path)
    assert record.headers["x-extra"] == "1"
    assert record.body == json.loads(body)


# -- the relay ----------------------------------------------------------------------------------


# #546-T01
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


# #546-T01
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


# #546-T08
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


# #546-T01
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


# #546-T02
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


# -- fault and framing variants -----------------------------------------------------------------


# #546-T02
def test_a_chat_stream_carries_usage_only_for_a_request_that_asked_for_it() -> None:
    path = request_path("chat", MODEL)
    plain: dict[str, Any] = {"model": MODEL, "stream": True, "tools": tools_for("chat")}
    asked = {**plain, "stream_options": {"include_usage": True}}

    with upstream("chat", TOOL) as server:
        with_usage = send(
            server.url, "POST", path, json.dumps(asked).encode(), headers_for("chat", REAL)
        )
        without = send(
            server.url, "POST", path, json.dumps(plain).encode(), headers_for("chat", REAL)
        )

    assert with_usage[2] == b"".join(stream("chat", TOOL, 1, MODEL, include_usage=True))
    assert without[2] == b"".join(stream("chat", TOOL, 2, MODEL, include_usage=False))
    assert b'"usage"' in with_usage[2] and b'"usage"' not in without[2]


# #546-T02
@pytest.mark.parametrize("size", (1, 7, 64))
def test_a_stream_can_be_re_chunked_at_arbitrary_byte_boundaries_without_changing_a_byte(
    size: int,
) -> None:
    path, body = request("messages")
    whole = b"".join(stream("messages", TOOL, 1, MODEL))

    with upstream("messages", TOOL) as server:
        server.rechunk = size
        chunks = raw_chunks(server.url, path, body, headers_for("messages", REAL))

    assert b"".join(chunks) == whole
    assert all(len(chunk) <= size for chunk in chunks)
    assert len(chunks) > len(stream("messages", TOOL, 1, MODEL))
    assert any(not chunk.endswith(b"\n\n") for chunk in chunks)


# #546-T02
def test_a_relay_hands_on_a_re_chunked_crlf_stream_byte_for_byte_and_the_tee_holds_it() -> None:
    whole = b"".join(stream("google", TOOL, 1, MODEL, crlf=True, cumulative_usage=True))

    with (
        upstream("google", TOOL) as server,
        KeySwapRelay("google", server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        server.rechunk, server.crlf, server.google_cumulative_usage = 5, True, True
        status, _, data = ask(relay.url, "google", DUMMY, streaming=True)

    assert status == 200
    assert data == whole
    assert relay.seen[0].response_bytes == whole
    assert b"\r\n\r\n" in data


# #546-T02
def test_the_google_upstream_can_state_the_usage_on_every_chunk() -> None:
    with upstream("google", TOOL) as server:
        server.google_cumulative_usage = True
        _, _, data = ask(server.url, "google", REAL, streaming=True)

    assert data == b"".join(stream("google", TOOL, 1, MODEL, cumulative_usage=True))
    assert [("usageMetadata" in chunk) for _, chunk in parse_sse(data.split(b"\n\n"))[:2]] == [
        True,
        True,
    ]


# #546-T07
def test_a_stream_can_end_in_an_error_event_after_a_200_and_the_retry_gets_the_same_turn() -> None:
    with upstream("messages", TOOL) as server:
        server.error_in_stream(after_events=3, times=1)
        status, _, data = ask(server.url, "messages", REAL, streaming=True)
        again = ask(server.url, "messages", REAL, streaming=True)

    assert status == 200
    last = parse_sse([data.split(b"\n\n")[-2] + b"\n\n"])[0]
    assert last[0] == "error"
    assert last[1]["error"]["type"] == "overloaded_error"
    assert b"message_stop" not in data
    assert again[2] == b"".join(stream("messages", TOOL, 1, MODEL))


# #546-T07
def test_a_failure_can_state_the_retry_after_of_the_test_and_a_500_states_none_by_default() -> None:
    with upstream("chat") as server:
        server.fail_next(500)
        server.fail_next(503, retry_after="1")
        server.fail_next(429)
        replies = [ask(server.url, "chat", REAL, streaming=False) for _ in range(3)]

    assert [status for status, _, _ in replies] == [500, 503, 429]
    assert [headers.get("retry-after") for _, headers, _ in replies] == [None, "1", "0"]


# #546-T07
@pytest.mark.parametrize("family", FAMILIES)
def test_an_upstream_can_quote_the_key_it_was_sent_in_its_error_messages(family: Family) -> None:
    with upstream(family) as server:
        server.quote_key = True
        server.fail_next(500)
        failed = ask(server.url, family, REAL, streaming=False)
        refused = ask(server.url, family, DUMMY, streaming=False)

    assert REAL in failed[2].decode()
    assert DUMMY in refused[2].decode() and REAL not in refused[2].decode()


# #546-T07
def test_a_relay_hands_on_an_answer_that_has_no_content_length_without_losing_its_body() -> None:
    with (
        upstream("chat", SAY) as server,
        KeySwapRelay("chat", server.url, dummy_key=DUMMY, real_key=REAL) as relay,
    ):
        server.close_delimited = True
        status, headers, data = ask(relay.url, "chat", DUMMY, streaming=False)

    assert status == 200
    assert "content-length" not in headers
    assert json.loads(data) == answer("chat", SAY, 1, MODEL)
    assert relay.seen[0].response_bytes == data


# -- the model of the job -----------------------------------------------------------------------


# #546-T08
@pytest.mark.parametrize("family", ("chat", "responses", "messages"))
def test_a_relay_pinned_to_the_model_of_the_job_refuses_another_model_before_the_upstream(
    family: Family,
) -> None:
    with (
        upstream(family, TOOL) as server,
        KeySwapRelay(
            family, server.url, dummy_key=DUMMY, real_key=REAL, pinned_model=MODEL
        ) as relay,
    ):
        refused = ask(relay.url, family, DUMMY, model="the-expensive-model")
        allowed = ask(relay.url, family, DUMMY, model=MODEL)

    assert refused[0] == 403
    assert allowed[0] == 200
    assert [seen.status for seen in relay.seen] == [403, 200]
    assert len(server.records) == 1


# #546-T09
def test_a_pinned_relay_reads_the_model_of_a_google_call_from_its_path() -> None:
    other, body = request("google", model="the-expensive-model")
    with (
        upstream("google", TOOL) as server,
        KeySwapRelay(
            "google", server.url, dummy_key=DUMMY, real_key=REAL, pinned_model=MODEL
        ) as relay,
    ):
        refused = send(relay.url, "POST", other, body, headers_for("google", DUMMY))
        allowed = ask(relay.url, "google", DUMMY)

    assert (refused[0], allowed[0]) == (403, 200)
    assert len(server.records) == 1


# #546-T08
def test_a_relay_pinned_to_the_model_of_the_job_refuses_a_call_that_names_no_model() -> None:
    with (
        upstream("messages") as server,
        KeySwapRelay(
            "messages", server.url, dummy_key=DUMMY, real_key=REAL, pinned_model=MODEL
        ) as relay,
    ):
        status, _, _ = send(
            relay.url, "POST", "/v1/messages", b"{}", headers_for("messages", DUMMY)
        )

    assert status == 403
    assert server.records == []


# -- serving several models, and asking again ----------------------------------------------------


# #546-T03
def test_an_upstream_can_serve_more_than_one_model_and_still_refuses_the_rest() -> None:
    with ScriptedUpstream("chat", [SAY], MODEL, real_key=REAL, also_models=("other-9",)) as server:
        own = ask(server.url, "chat", REAL, streaming=False)
        other = ask(server.url, "chat", REAL, streaming=False, model="other-9")
        stranger = ask(server.url, "chat", REAL, streaming=False, model="third-9")

    assert (own[0], other[0], stranger[0]) == (200, 200, 404)


# #546-T02
def test_a_chat_stream_carries_usage_for_the_openrouter_form_of_the_request_too() -> None:
    path = request_path("chat", MODEL)
    body = {"model": MODEL, "stream": True, "tools": tools_for("chat"), "usage": {"include": True}}

    with upstream("chat", TOOL) as server:
        _, _, data = send(
            server.url, "POST", path, json.dumps(body).encode(), headers_for("chat", REAL)
        )

    assert data == b"".join(stream("chat", TOOL, 1, MODEL, include_usage=True))


# #546-T07
def test_restarting_the_script_and_resetting_the_faults_make_the_upstream_ready_again() -> None:
    first, second = Turn(tool="read", args={}), Turn(tool="grep", args={})

    with upstream("chat", first, second) as server:
        server.fail_next(500, 500)
        server.quote_key = True
        server.cut_streams(after_events=1, times=3)
        server.error_in_stream(after_events=1, times=3)
        server.reset_faults()
        server.restart()
        served = [ask(server.url, "chat", REAL, streaming=False) for _ in range(2)]
        server.restart()
        again = ask(server.url, "chat", REAL, streaming=False)
        streamed = ask(server.url, "chat", REAL, streaming=True)

    assert [reply[0] for reply in served] == [200, 200]
    assert (
        json.loads(again[2])["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "read"
    )
    assert streamed[0] == 200 and b"[DONE]" in streamed[2]
    assert not server.quote_key


# #551-F02
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("fault", ["missing", "unknown_field", "bad_value"])
def test_the_upstream_can_answer_with_a_usage_fault_in_a_document_and_in_a_stream(
    family: Family, fault: str
) -> None:
    with upstream(family, TOOL) as server:
        server.usage_fault = fault  # type: ignore[assignment]
        _, _, plain = ask(server.url, family, REAL, streaming=False)
        _, _, streamed = ask(server.url, family, REAL, streaming=True)
        server.reset_faults()
        _, _, healthy = ask(server.url, family, REAL, streaming=False)

    assert json.loads(plain) == answer(family, TOOL, 1, MODEL, usage_fault=fault)  # type: ignore[arg-type]
    assert streamed == b"".join(stream(family, TOOL, 2, MODEL, usage_fault=fault))  # type: ignore[arg-type]
    assert json.loads(healthy) == answer(family, TOOL, 3, MODEL)


# -- the number of the call is taken before the answer is sent (#551-F02, #567) -------------------


class _Load:
    """CPU load in the background: threads that never wait, as a loaded CI machine."""

    def __init__(self, threads: int = 2) -> None:
        self._stop = threading.Event()
        self._threads = [threading.Thread(target=self._burn, daemon=True) for _ in range(threads)]

    def _burn(self) -> None:
        while not self._stop.is_set():
            sum(range(2000))

    def __enter__(self) -> "_Load":
        for thread in self._threads:
            thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=5.0)


# #567-T01
@pytest.mark.parametrize("streaming", [False, True])
def test_a_restart_right_after_an_answer_starts_the_script_from_its_first_turn(
    streaming: bool,
) -> None:
    # The turn used by an answer was counted after the answer had been written, so a restart that
    # came at once was undone by that late count and the next answer was the second turn. This is
    # also why the call numbers of #551-F02 (a document, a stream, a document) could repeat.
    first, second = Turn(tool="read", args={}), Turn(tool="grep", args={})
    with upstream("chat", first, second) as server, _Load():
        names: list[str] = []
        for _ in range(30):
            server.restart()
            ask(server.url, "chat", REAL, streaming=streaming)
            server.restart()
            _, _, data = ask(server.url, "chat", REAL, streaming=False)
            names.append(
                json.loads(data)["choices"][0]["message"]["tool_calls"][0]["function"]["name"]
            )

    assert set(names) == {"read"}
