# SPDX-License-Identifier: LicenseRef-Proprietary

"""Which destinations may receive the real key (#550, T07).

The rules are those of `app/src/billing/public-url.ts` (the app judges the catalog's address when it
stores it) and the extensions of the catalog (#548), applied here to the address the supervisor
really connects to: https only, no credentials, no query, port 443 only, a public name or address.
Loopback, private, link-local, shared (CGNAT), multicast, reserved and documentation ranges, the
special-purpose ranges of IANA, NAT64 and 6to4 are refused; an IPv4-mapped IPv6 address is judged by
the IPv4 address in it.

A name is not judged here, only its form: it is resolved when a connection is made, and the address
is judged and connected to then (`upstream.py`).
"""

import ipaddress
import re
from typing import Final
from urllib.parse import urlsplit

from code_reviewer_runner.result import ErrorCode

# Not in the global unicast block of IPv6 (2000::/3): `::`, `::1`, IPv4-compatible `::a.b.c.d`,
# NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, discard `100::/64`, unique local, link-local, the
# deprecated site-local and multicast. Inside it: the IETF protocol assignments `2001::/23`
# (Teredo, ORCHID, benchmarking), documentation `2001:db8::/32` and `3fff::/20`, and 6to4
# `2002::/16`.
_GLOBAL_UNICAST: Final = ipaddress.ip_network("2000::/3")
_V6_REFUSED: Final = tuple(
    ipaddress.ip_network(network)
    for network in ("2001::/23", "2001:db8::/32", "3fff::/20", "2002::/16")
)
# Python's `is_global` follows IANA's registries but lets these through: the 6to4 relay anycast and
# the IETF protocol assignments block (whose few global entries no provider uses).
_V4_REFUSED: Final = tuple(
    ipaddress.ip_network(network) for network in ("192.88.99.0/24", "192.0.0.0/24")
)
_HOST: Final = re.compile(
    r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"
)
_PATH: Final = re.compile(r"^(/[A-Za-z0-9._~-]+)*/?$")
_LOCAL_SUFFIXES: Final = (".localhost", ".local", ".internal")


class UpstreamRefused(ValueError):
    """The upstream address of the job may not receive the key. Never carries the address."""

    code = ErrorCode.DYNAMIC_CONFIG_INVALID

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def is_public_address(text: str) -> bool:
    """Whether a resolved address (no brackets) is one the internet can reach."""
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return is_public_address(str(address.ipv4_mapped))
        if address not in _GLOBAL_UNICAST or any(address in net for net in _V6_REFUSED):
            return False
    elif any(address in net for net in _V4_REFUSED):
        return False
    # IPv4 multicast is "global" for Python; no provider is a multicast group.
    return address.is_global and not address.is_multicast


def check_base_url(url: str) -> str:
    """The upstream base URL in one spelling (no trailing slash), or `UpstreamRefused`."""
    if not url.startswith("https://") or re.search(r"[\s?#@\\]", url):
        raise UpstreamRefused("the upstream address is not a plain https address")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise UpstreamRefused("the upstream address cannot be read") from None
    host = (parts.hostname or "").rstrip(".").lower()
    if not host or port not in (None, 443) or parts.username or parts.password:
        raise UpstreamRefused("the upstream address has no host, or a port other than 443")
    if _PATH.fullmatch(parts.path) is None or any(
        segment in (".", "..") for segment in parts.path.split("/")
    ):
        raise UpstreamRefused("the upstream path is not a plain path")
    if parts.netloc.startswith("["):
        if not is_public_address(host):
            raise UpstreamRefused("the upstream address is not public")
        shown = f"[{host}]"
    elif re.fullmatch(r"[0-9.]+", host):
        # A dotted IPv4 address; `2130706433` and `0x7f.1` are no host name either.
        if not is_public_address(host):
            raise UpstreamRefused("the upstream address is not public")
        shown = host
    else:
        # A name has at least two labels and a last one that is no number (`0x7f.0.0.1`), and
        # is not known only on a private network.
        top = host.rsplit(".", 1)[-1]
        if (
            _HOST.fullmatch(host) is None
            or not re.search(r"[a-z]", top)
            or top.startswith("0x")
            or host == "localhost"
            or host.endswith(_LOCAL_SUFFIXES)
        ):
            raise UpstreamRefused("the upstream name is not a public name")
        shown = host
    return f"https://{shown}{parts.path.rstrip('/')}"
