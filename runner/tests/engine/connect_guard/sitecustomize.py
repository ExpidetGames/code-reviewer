"""Loaded by the interpreter of the job process in the engine suite (through PYTHONPATH).

A guard at the level of Python's `socket` module: it records every connection, datagram and name
lookup the process starts through it in the file named by ENGINE_CONNECT_LOG (one JSON line per
attempt) and refuses everything that is not loopback. The libraries PR-Agent uses (requests, httpx,
aiohttp, asyncio, LiteLLM) all go through `socket.socket.connect` and `socket.getaddrinfo`, so the
guard sees what they do on any machine, also on one with internet access. It does not see code that
bypasses the module (the C level `_socket`, a subprocess); the CI job adds an operating system
level guarantee for that by running the suite in a network namespace without any route out. Unix
sockets are not network connections.
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
_sendto = socket.socket.sendto
_getaddrinfo = socket.getaddrinfo
_gethostbyname = socket.gethostbyname
_gethostbyname_ex = socket.gethostbyname_ex
_gethostbyaddr = socket.gethostbyaddr


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


def sendto(self: socket.socket, data: Any, *args: Any) -> int:
    address: Any = args[-1] if args else None
    if address is not None and _is_network(self, address):
        _check("datagram", address[0], address[1])
    return _sendto(self, data, *args)


def gethostbyname(host: str) -> str:
    if host not in _LOOPBACK:
        _check("resolve", host, None)
    return _gethostbyname(host)


def gethostbyname_ex(host: str) -> Any:
    if host not in _LOOPBACK:
        _check("resolve", host, None)
    return _gethostbyname_ex(host)


def gethostbyaddr(host: str) -> Any:
    if host not in _LOOPBACK:
        _check("resolve", host, None)
    return _gethostbyaddr(host)


socket.socket.connect = connect  # type: ignore[method-assign]
socket.socket.connect_ex = connect_ex  # type: ignore[method-assign]
socket.socket.sendto = sendto  # type: ignore[method-assign]
socket.getaddrinfo = getaddrinfo
socket.gethostbyname = gethostbyname
socket.gethostbyname_ex = gethostbyname_ex
socket.gethostbyaddr = gethostbyaddr
