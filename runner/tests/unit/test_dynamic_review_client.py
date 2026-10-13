# SPDX-License-Identifier: Apache-2.0

"""Pins down the request shape of the engine client (#197), without a socket.

The client is the only thing that talks to the engine's HTTP API. It scopes session requests to the
prepared export with the directory header, names the runner's own provider and agent, and treats a
session list it cannot read as an unobservable run, never as an empty one.
"""

import json
from collections.abc import Mapping
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.adapter import EngineClient, EngineError
from code_reviewer_runner.dynamic_review.config import PROXY_PROVIDER_ID
from code_reviewer_runner.result import ErrorCode

DIRECTORY_HEADER = "x-opencode-directory"


class Recorder:
    """A transport that records every request and answers what the test scripts."""

    def __init__(self, status: int = 200, body: Any = None) -> None:
        self.status = status
        self.body = {"healthy": True, "version": "1.19.0"} if body is None else body
        self.requests: list[tuple[str, str, bytes | None, Mapping[str, str]]] = []

    def __call__(
        self, method: str, url: str, body: bytes | None, headers: Mapping[str, str]
    ) -> tuple[int, bytes]:
        self.requests.append((method, url, body, headers))
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
    client.send_message("ses-1", model="deepseek-v4.1-flash", parts=[], schema={})

    assert len(transport.requests) == 2
    for _, _, _, headers in transport.requests:
        assert headers[DIRECTORY_HEADER] == "/export"


# #197-T03
def test_the_message_names_the_runner_provider_and_agent() -> None:
    transport = Recorder(body={"id": "msg-1"})
    client = EngineClient("http://127.0.0.1:4000", "/export", transport=transport)

    client.send_message("ses-1", model="deepseek-v4.1-flash", parts=[], schema={})

    body = json.loads(transport.requests[0][2] or b"")
    assert body["agent"] == "review"
    assert body["model"] == {"providerID": PROXY_PROVIDER_ID, "modelID": "deepseek-v4.1-flash"}


# #197-T05
def test_a_session_list_that_cannot_be_read_is_not_an_empty_list() -> None:
    for status, body in ((400, {"error": "Expected OutputFormatJsonSchema"}), (200, {"a": 1})):
        client = EngineClient(
            "http://127.0.0.1:4000", "/export", transport=Recorder(status=status, body=body)
        )

        with pytest.raises(EngineError) as unobservable:
            client.messages("ses-1")

        assert unobservable.value.code is ErrorCode.DYNAMIC_ACCOUNTING_FAILED
