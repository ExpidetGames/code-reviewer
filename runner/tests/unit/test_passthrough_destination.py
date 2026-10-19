# SPDX-License-Identifier: Apache-2.0

"""Where the passthrough proxy may send the real key (#550, T07).

The upstream is one trusted https base URL per job. It is judged when the job starts, and the
address it resolves to is judged again on every connection and connected to as judged (a name can
change what it resolves to between two calls). The rules are those of
`app/src/billing/public-url.ts`, with the extensions of the catalog (#548): the special-purpose
ranges, NAT64, 6to4 and port 443 only.
"""

import socket
import threading
from collections.abc import Callable
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.passthrough.address import (
    UpstreamRefused,
    check_base_url,
    is_public_address,
)
from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpsUpstream,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
)

PUBLIC = [
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
]
NOT_PUBLIC = [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "127.255.255.254",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "100::1",
    "64:ff9b::808:808",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "2002:808:808::1",
    "2002:a00:1::1",
    "2001::1",
    "2001:db8::1",
    "3fff::1",
    "not an address",
    "",
]


# #550-T07
@pytest.mark.parametrize("address", PUBLIC)
def test_a_public_address_passes(address: str) -> None:
    assert is_public_address(address)


# #550-T07
@pytest.mark.parametrize("address", NOT_PUBLIC)
def test_loopback_private_link_local_and_special_purpose_addresses_are_refused(
    address: str,
) -> None:
    assert not is_public_address(address)


# #550-T07
@pytest.mark.parametrize(
    "url",
    [
        "https://api.example.com",
        "https://api.example.com/v1",
        "https://api.example.com:443/v1",
        "https://93.184.216.34/v1",
        "https://[2606:4700:4700::1111]/v1",
    ],
)
def test_a_public_https_base_url_is_accepted(url: str) -> None:
    assert check_base_url(url).startswith("https://")


# #550-T07
@pytest.mark.parametrize(
    "url",
    [
        "http://api.example.com/v1",
        "ftp://api.example.com",
        "api.example.com",
        "https://",
        "https://user:pass@api.example.com/v1",
        "https://api.example.com/v1?key=x",
        "https://api.example.com/v1#x",
        "https://api.example.com:8443/v1",
        "https://api.example.com:80/v1",
        "https://127.0.0.1/v1",
        "https://localhost/v1",
        "https://api.localhost/v1",
        "https://10.0.0.5/v1",
        "https://169.254.169.254/latest",
        "https://[::1]/v1",
        "https://[fe80::1]/v1",
        "https://[64:ff9b::808:808]/v1",
        "https://[2002:808:808::1]/v1",
        "https://intranet/v1",
        "https://db.internal/v1",
        "https://printer.local/v1",
        "https://0x7f.0.0.1/v1",
        "https://2130706433/v1",
        "https://api.example.com/v1/../../x",
        "https://api.example.com/v1 x",
    ],
)
def test_any_other_base_url_is_refused_at_job_start(url: str) -> None:
    with pytest.raises(UpstreamRefused):
        check_base_url(url)


# -- the connection ---------------------------------------------------------------------------


class Wire:
    """What the connection did, with a socket pair standing in for the TLS connection."""

    def __init__(self, answer: bytes) -> None:
        self.resolved: list[str] = []
        self.connected: list[tuple[str, int]] = []
        self.hostnames: list[str] = []
        self.requests: list[bytes] = []
        self._answer = answer

    def resolve(self, addresses: list[str]) -> Callable[[str], list[str]]:
        def resolve(host: str) -> list[str]:
            self.resolved.append(host)
            return addresses

        return resolve

    def connect(self, address: tuple[str, int], timeout: float) -> Any:
        self.connected.append(address)
        client, server = socket.socketpair()
        threading.Thread(target=self._serve, args=(server,), daemon=True).start()
        return client

    def tls(self, raw: Any, hostname: str) -> Any:
        self.hostnames.append(hostname)
        return raw

    def _serve(self, server: socket.socket) -> None:
        with server:
            received = b""
            while b"\r\n\r\n" not in received:
                received += server.recv(65536)
            self.requests.append(received)
            server.sendall(self._answer)


ANSWER = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok"


def upstream(wire: Wire, addresses: list[str], base: str = "https://api.example.com/v1") -> Any:
    return HttpsUpstream(base, resolve=wire.resolve(addresses), connect=wire.connect, tls=wire.tls)


def request() -> UpstreamRequest:
    return UpstreamRequest(
        path="/chat/completions",
        headers={"authorization": "Bearer real", "content-type": "application/json"},
        body=b"{}",
    )


# #550-T07
def test_the_connection_goes_to_the_address_that_was_checked_on_port_443() -> None:
    wire = Wire(ANSWER)
    response = upstream(wire, ["93.184.216.34"]).send(request(), 5.0)
    assert wire.connected == [("93.184.216.34", 443)]
    assert wire.hostnames == ["api.example.com"]
    assert response.status == 200
    assert response.read(100) == b"ok"
    assert response.read(100) == b""
    sent = wire.requests[0]
    assert sent.startswith(b"POST /v1/chat/completions HTTP/1.1\r\n")
    assert b"Host: api.example.com\r\n" in sent
    assert b"authorization: Bearer real" in sent


# #550-T07
def test_a_name_that_resolves_to_a_private_address_later_is_refused_on_that_connection() -> None:
    wire = Wire(ANSWER)
    addresses = ["93.184.216.34"]
    fresh = HttpsUpstream(
        "https://api.example.com/v1",
        resolve=lambda host: addresses,
        connect=wire.connect,
        tls=wire.tls,
    )
    fresh.send(request(), 5.0).close()
    addresses[:] = ["10.0.0.7"]
    with pytest.raises(UpstreamError) as raised:
        fresh.send(request(), 5.0)
    assert raised.value.kind is UpstreamFailure.ADDRESS_REFUSED
    # Nothing was sent to the key's destination: the call can be given back.
    assert not raised.value.sent
    assert wire.connected == [("93.184.216.34", 443)]


# #550-T07
def test_one_private_address_among_several_refuses_the_name() -> None:
    wire = Wire(ANSWER)
    with pytest.raises(UpstreamError) as raised:
        upstream(wire, ["93.184.216.34", "169.254.169.254"]).send(request(), 5.0)
    assert raised.value.kind is UpstreamFailure.ADDRESS_REFUSED
    assert wire.connected == []


# #550-T07
@pytest.mark.parametrize("addresses", [[], ["not-an-ip"]])
def test_a_name_that_does_not_resolve_to_an_address_is_unreachable(addresses: list[str]) -> None:
    wire = Wire(ANSWER)
    with pytest.raises(UpstreamError) as raised:
        upstream(wire, addresses).send(request(), 5.0)
    assert raised.value.kind in (UpstreamFailure.UNREACHABLE, UpstreamFailure.ADDRESS_REFUSED)
    assert wire.connected == []


# #550-T07
def test_a_redirect_is_handed_back_as_a_status_and_never_followed() -> None:
    wire = Wire(
        b"HTTP/1.1 307 Temporary Redirect\r\nLocation: https://evil.example/\r\n"
        b"Content-Length: 0\r\n\r\n"
    )
    response = upstream(wire, ["93.184.216.34"]).send(request(), 5.0)
    assert response.status == 307
    assert len(wire.connected) == 1


# #550-T07
def test_a_connection_that_is_cut_in_the_answer_is_a_cut_not_a_short_answer() -> None:
    wire = Wire(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
    response = upstream(wire, ["93.184.216.34"]).send(request(), 5.0)
    assert response.read(100) == b"partial"
    with pytest.raises(UpstreamError) as raised:
        response.read(100)
    assert raised.value.kind is UpstreamFailure.CUT
    # The request had been sent: the provider may have billed it.
    assert raised.value.sent
