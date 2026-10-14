# SPDX-License-Identifier: Apache-2.0

"""Pins down the HTTP client of the runner API against a real server on loopback: what it sends
(token, runner id, bodies of the contract) and how it tells the answers apart."""

import asyncio
import socket
from collections.abc import Iterator
from typing import Any

import pytest
from fake_app import RUNNER_TOKEN, FakeApp, RawServer, Scripted, claim_response

from code_reviewer_runner.job_loop.api import (
    ApiRejected,
    ApiUnavailable,
    HttpRunnerApi,
    LeaseLost,
)

JOB_ID = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10"
JOB_INPUT: dict[str, Any] = {
    "prUrl": "https://github.com/octo/repo/pull/7",
    "command": "review",
    "git": {
        "provider": "github",
        "baseUrl": "https://api.github.com",
        "token": "dummy-installation-token-0123456789",
        "botLogin": "code-reviewer[bot]",
    },
    "llm": {"provider": "openrouter", "model": "v/m", "apiKey": "dummy-openrouter-key-0123456789"},
    "env": {},
}
RESULT: dict[str, Any] = {
    "ok": True,
    "durationMs": 5,
    "commentUrl": None,
    "errorCode": None,
    "logTail": "",
    "logTruncated": False,
    "usage": None,
}


@pytest.fixture
def app() -> Iterator[FakeApp]:
    fake = FakeApp().start()
    yield fake
    fake.stop()


def client(app: FakeApp, token: str = RUNNER_TOKEN) -> HttpRunnerApi:
    return HttpRunnerApi(app.url, token, "client-test", request_timeout=5)


def test_a_claim_with_a_job_returns_the_lease_and_the_input_and_sends_token_and_runner_id(
    app: FakeApp,
) -> None:
    app.queue.append(claim_response(JOB_ID, JOB_INPUT, interval=45))

    claimed = asyncio.run(client(app).claim())

    assert claimed is not None
    assert (claimed.id, claimed.lease_token) == (JOB_ID, f"lease-{JOB_ID}")
    assert claimed.heartbeat_interval == 45
    assert claimed.input == JOB_INPUT
    headers = app.requests[0]["headers"]
    assert headers["Authorization"] == f"Bearer {RUNNER_TOKEN}"
    assert headers["X-Runner-Id"] == "client-test"
    # #195 finding 9: the client really sends the engines it was configured with.
    assert app.requests[0]["body"] == {"engines": ["pr-agent"]}
    assert app.violations == []


# #195 finding 9
def test_a_claim_advertises_the_configured_engines(app: FakeApp) -> None:
    app.queue.append(claim_response(JOB_ID, JOB_INPUT))

    asyncio.run(
        HttpRunnerApi(
            app.url,
            RUNNER_TOKEN,
            "client-test",
            engines=("pr-agent", "opencode"),
            request_timeout=5,
        ).claim()
    )

    assert app.requests[0]["body"] == {"engines": ["pr-agent", "opencode"]}
    assert app.violations == []


def test_a_claim_answered_with_204_means_no_job(app: FakeApp) -> None:
    assert asyncio.run(client(app).claim()) is None


def test_a_heartbeat_and_a_complete_send_the_bodies_of_the_contract(app: FakeApp) -> None:
    api = client(app)
    asyncio.run(api.heartbeat(JOB_ID, "lease-1234567890"))
    reply = asyncio.run(api.complete(JOB_ID, "lease-1234567890", RESULT))

    assert app.violations == []
    assert app.heartbeats == [JOB_ID]
    assert app.completions[0]["result"] == RESULT
    assert reply.status == "succeeded" and reply.already_completed is False


def test_a_complete_answer_with_the_status_queued_is_understood(app: FakeApp) -> None:
    app.complete_status = "queued"

    reply = asyncio.run(client(app).complete(JOB_ID, "lease-1234567890", RESULT))

    assert reply.status == "queued"


@pytest.mark.parametrize("status", [500, 502, 503, 429, 401])
def test_an_answer_that_may_pass_is_unavailable_and_keeps_the_retry_after(
    app: FakeApp, status: int
) -> None:
    app.script(
        "claim", Scripted(status, {"error": {"code": "X", "message": "m"}}, {"Retry-After": "7"})
    )

    with pytest.raises(ApiUnavailable) as error:
        asyncio.run(client(app).claim())

    assert error.value.status == status
    assert error.value.retry_after == 7


def test_a_conflict_on_a_heartbeat_or_complete_means_the_lease_is_lost(app: FakeApp) -> None:
    app.lost.add(JOB_ID)
    api = client(app)

    with pytest.raises(LeaseLost):
        asyncio.run(api.heartbeat(JOB_ID, "lease-1234567890"))
    with pytest.raises(LeaseLost):
        asyncio.run(api.complete(JOB_ID, "lease-1234567890", RESULT))


@pytest.mark.parametrize("status", [400, 413])
def test_a_refusal_of_the_request_is_rejected_with_the_error_code(
    app: FakeApp, status: int
) -> None:
    app.script(
        "complete", Scripted(status, {"error": {"code": "RUNNER_BODY_TOO_LARGE", "message": "m"}})
    )

    with pytest.raises(ApiRejected) as error:
        asyncio.run(client(app).complete(JOB_ID, "lease-1234567890", RESULT))

    assert (error.value.status, error.value.code) == (status, "RUNNER_BODY_TOO_LARGE")


def test_a_wrong_token_is_unavailable_and_the_error_does_not_show_the_token(app: FakeApp) -> None:
    with pytest.raises(ApiUnavailable) as error:
        asyncio.run(client(app, token="wrong-token-0123456789-abcdef-0123456789").claim())

    assert error.value.status == 401
    assert "wrong-token" not in str(error.value)


def test_an_app_that_cannot_be_reached_is_unavailable() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    api = HttpRunnerApi(f"http://127.0.0.1:{port}", RUNNER_TOKEN, "client-test", request_timeout=2)

    with pytest.raises(ApiUnavailable) as error:
        asyncio.run(api.claim())

    assert error.value.status is None
    assert str(port) not in str(error.value)


def test_a_claim_answer_that_breaks_the_contract_is_unavailable(app: FakeApp) -> None:
    broken = claim_response(JOB_ID, JOB_INPUT)
    broken["job"]["leaseToken"] = "x"
    app.script("claim", Scripted(200, broken))

    with pytest.raises(ApiUnavailable):
        asyncio.run(client(app).claim())


def test_a_job_id_that_is_not_a_uuid_is_never_put_into_a_url(app: FakeApp) -> None:
    with pytest.raises(ApiRejected):
        asyncio.run(client(app).heartbeat("../../etc/passwd", "lease-1234567890"))

    assert app.requests == []


def test_a_redirect_is_not_followed_so_the_token_never_goes_elsewhere(app: FakeApp) -> None:
    other = FakeApp().start()
    try:
        app.script("claim", Scripted(307, None, {"Location": f"{other.url}/api/runners/v1/claim"}))

        with pytest.raises(ApiUnavailable):
            asyncio.run(client(app).claim())

        assert other.requests == []
    finally:
        other.stop()


def test_a_heartbeat_interval_longer_than_the_lease_allows_is_shortened(app: FakeApp) -> None:
    app.queue.append(claim_response(JOB_ID, JOB_INPUT, interval=600))

    claimed = asyncio.run(client(app).claim())

    assert claimed is not None and claimed.heartbeat_interval == 60


GARBAGE = [
    pytest.param(b"GARBAGE\r\n\r\n", id="not an HTTP answer"),
    pytest.param(b"HTTP/1.1 2", id="status line cut off"),
    pytest.param(b"", id="closed without an answer"),
]


@pytest.mark.parametrize("answer", GARBAGE)
def test_an_answer_that_is_not_http_is_unavailable_for_every_call(answer: bytes) -> None:
    server = RawServer(answer)
    try:
        api = HttpRunnerApi(server.url, RUNNER_TOKEN, "client-test", request_timeout=5)

        with pytest.raises(ApiUnavailable):
            asyncio.run(api.claim())
        with pytest.raises(ApiUnavailable):
            asyncio.run(api.heartbeat(JOB_ID, "lease-1234567890"))
        with pytest.raises(ApiUnavailable):
            asyncio.run(api.complete(JOB_ID, "lease-1234567890", RESULT))
    finally:
        server.close()


def test_a_text_with_a_lone_surrogate_is_sent_as_an_escape_and_arrives(app: FakeApp) -> None:
    result = {**RESULT, "logTail": "broken \ud800 text"}

    asyncio.run(client(app).complete(JOB_ID, "lease-1234567890", result))

    assert app.completions[0]["result"]["logTail"] == "broken \ud800 text"


def test_a_claim_answer_that_is_cut_off_is_unavailable() -> None:
    server = RawServer(b'HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n{"version": 1, ')
    try:
        api = HttpRunnerApi(server.url, RUNNER_TOKEN, "client-test", request_timeout=5)

        with pytest.raises(ApiUnavailable):
            asyncio.run(api.claim())
    finally:
        server.close()


def _answer_200(body: bytes) -> bytes:
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )


# #260: a 200 only means "held" when it is the answer of the contract for this very job. A gateway
# or captive portal that answers 200 to everything must not authorize a write.
@pytest.mark.parametrize(
    "body",
    [
        pytest.param(b"OK", id="not JSON"),
        pytest.param(b"{}", id="an empty object"),
        pytest.param(b'{"version": 1}', id="no job"),
        pytest.param(b'{"version": 2, "job": {"id": "' + JOB_ID.encode() + b'"}}', id="version"),
        pytest.param(
            b'{"version": 1, "job": {"id": "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b11"}}',
            id="another job",
        ),
        pytest.param(b'{"version": 1, "job": {"id": 7}}', id="id is not text"),
    ],
)
def test_a_200_that_is_not_the_heartbeat_answer_of_the_job_is_unavailable(body: bytes) -> None:
    server = RawServer(_answer_200(body))
    try:
        api = HttpRunnerApi(server.url, RUNNER_TOKEN, "client-test", request_timeout=5)

        with pytest.raises(ApiUnavailable):
            asyncio.run(api.heartbeat(JOB_ID, "lease-1234567890"))
    finally:
        server.close()
