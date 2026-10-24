# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down that runner tests cannot reach the internet: pytest-socket blocks every host except
loopback in the default run, so a real outbound call can never slip into a test by accident."""

import socket

import pytest
from pytest_socket import SocketConnectBlockedError


# CR-14-T07
def test_a_connection_to_an_external_host_is_blocked() -> None:
    with pytest.raises(SocketConnectBlockedError), socket.create_connection(("203.0.113.10", 80)):
        pass


# CR-14-T07
def test_a_connection_to_an_external_ipv6_address_is_blocked() -> None:
    with pytest.raises(SocketConnectBlockedError), socket.create_connection(("2001:db8::10", 80)):
        pass


# CR-14-T07
def test_a_connection_to_loopback_is_still_allowed() -> None:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]

        with socket.create_connection(("127.0.0.1", port)) as client:
            connection, _ = server.accept()
            with connection:
                client.sendall(b"ping")
                assert connection.recv(4) == b"ping"
