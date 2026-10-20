# SPDX-License-Identifier: Apache-2.0

"""The passthrough model proxy of the native OpenCode providers (#550, design #544).

The engine speaks the provider's own wire family to a loopback proxy and holds only the job's random
capability; the proxy checks what the engine asks for, swaps the capability for the real key, relays
the bytes unchanged and counts. Nothing in this package translates a request or an answer. The
legacy proxy (`proxy.py`, `anthropic_wire.py`) stays the production path for the providers of today
until #556 removes it.

Modules, each small on purpose:

- `families`: the four wire families, their key header, path, header allow-list and output cap;
- `admission`: the decision on a request before a byte is reserved or forwarded;
- `address`, `upstream`: the destination, checked on every connection;
- `redact`: what is cut out of an answer that quotes the key;
- `sse`, `usage`, `pricing`: the tee that reads the usage from the bytes, and what a call costs;
- `proxy`, `server`: the relay with the ledger around it, and the loopback server for it.
"""
