"""Loaded by the interpreter of the job process in the engine suite (through PYTHONPATH).

Records every network connection the process opens in the file named by ENGINE_CONNECT_LOG (one
JSON line per attempt) and refuses everything that is not loopback. This is the "only loopback is
reachable" environment of the engine suite, built into the process itself: the suite proves the
claim on any machine, also on one with internet access. Unix sockets are not network connections.
"""

import json
import os
import socket
from typing import Any

_LOG = os.environ.get("ENGINE_CONNECT_LOG")
_LOOPBACK = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}


def _record(kind: str, target: str, allowed: bool) -> None:
    if not _LOG:
        return
    line = json.dumps({"kind": kind, "target": target, "allowed": allowed}) + "\n"
    descriptor = os.open(_LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, line.encode())
    finally:
        os.close(descriptor)


def _check(kind: str, host: Any, port: Any) -> None:
    allowed = str(host) in _LOOPBACK
    _record(kind, f"{host}:{port}", allowed)
    if not allowed:
        raise OSError(f"engine suite: connection to {host} refused, only loopback is reachable")


_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_getaddrinfo = socket.getaddrinfo


def _is_network(self: socket.socket, address: Any) -> bool:
    return self.family in (socket.AF_INET, socket.AF_INET6) and isinstance(address, tuple)


def connect(self: socket.socket, address: Any) -> None:
    if _is_network(self, address):
        _check("connect", address[0], address[1])
    return _connect(self, address)


def connect_ex(self: socket.socket, address: Any) -> int:
    if _is_network(self, address):
        _check("connect", address[0], address[1])
    return _connect_ex(self, address)


def getaddrinfo(host: Any, port: Any, *args: Any, **kwargs: Any) -> Any:
    if host is not None and str(host) not in _LOOPBACK:
        _check("resolve", host, port)
    return _getaddrinfo(host, port, *args, **kwargs)


socket.socket.connect = connect  # type: ignore[method-assign]
socket.socket.connect_ex = connect_ex  # type: ignore[method-assign]
socket.getaddrinfo = getaddrinfo
