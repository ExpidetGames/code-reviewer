# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the request shape of the engine client (#197), without a socket.

The client is the only thing that talks to the engine's HTTP API. It scopes session requests to the
prepared export with the directory header, names the runner's own provider and agent, and treats a
session list it cannot read as an unobservable run, never as an empty one.
"""

import json
from collections.abc import Mapping
from typing import Any

from code_reviewer_runner.dynamic_review.adapter import EngineClient
from code_reviewer_runner.dynamic_review.config import PROXY_PROVIDER_ID

DIRECTORY_HEADER = "x-opencode-directory"


class Recorder:
    """A transport that records every request and answers what the test scripts."""

    def __init__(self, status: int = 200, body: Any = None) -> None:
        self.status = status
        self.body = {"healthy": True, "version": "1.19.0"} if body is None else body
        self.requests: list[tuple[str, str, bytes | None, Mapping[str, str]]] = []
        self.timeouts: list[float] = []

    def __call__(
        self,
        method: str,
        url: str,
        body: bytes | None,
        headers: Mapping[str, str],
        timeout: float,
    ) -> tuple[int, bytes]:
        self.requests.append((method, url, body, headers))
        self.timeouts.append(timeout)
        return self.status, json.dumps(self.body).encode("utf-8")


# #197-T02
def test_the_health_check_does_not_carry_the_directory_header() -> None:
    transport = Recorder()
    client = EngineClient("http://127.0.0.1:4000", "/export", transport=transport)

    assert client.health() is True

    _, url, _, headers = transport.requests[0]
    assert url == "http://127.0.0.1:4000/global/health"
    assert DIRECTORY_HEADER not in headers


# #197-T02
def test_every_session_request_is_scoped_to_the_prepared_export() -> None:
    transport = Recorder(body={"id": "ses-1"})
    client = EngineClient("http://127.0.0.1:4000", "/export", transport=transport)

    client.create_session()
    client.send_message("ses-1", model="deepseek/deepseek-v4.1-flash", parts=[], schema={})

    assert len(transport.requests) == 2
    for _, _, _, headers in transport.requests:
        assert headers[DIRECTORY_HEADER] == "/export"


# #197-T03
def test_the_message_names_the_runner_provider_and_agent() -> None:
    transport = Recorder(body={"id": "msg-1"})
    client = EngineClient("http://127.0.0.1:4000", "/export", transport=transport)

    client.send_message("ses-1", model="deepseek/deepseek-v4.1-flash", parts=[], schema={})

    body = json.loads(transport.requests[0][2] or b"")
    assert body["agent"] == "review"
    assert body["model"] == {
        "providerID": PROXY_PROVIDER_ID,
        "modelID": "deepseek/deepseek-v4.1-flash",
    }


# #197-T06
def test_a_health_poll_gives_up_quickly_instead_of_waiting_for_a_stalled_server() -> None:
    # Before its listening marker the pinned server can accept a connection and never answer (seen
    # against the real binary: a 120 s stall). The poll must not use the message timeout.
    transport = Recorder()
    client = EngineClient("http://127.0.0.1:4000", "/export", transport=transport)

    client.health()
    transport.body = {"id": "ses-1"}
    client.create_session()

    assert transport.timeouts[0] <= 5.0
    assert transport.timeouts[1] <= 60.0
    client.send_message("ses-1", model="deepseek/deepseek-v4.1-flash", parts=[], schema={})
    assert transport.timeouts[2] > 60.0


# #197-T13
def test_the_client_has_no_session_list_to_fail_on() -> None:
    # #85: the pinned server answers the stored-format message list with HTTP 400. The run does not
    # read it at all (the audit is at the proxy), so that defect cannot fail or blind a run.
    assert not hasattr(EngineClient, "messages")
