# SPDX-License-Identifier: Apache-2.0

"""HTTP openers for the Dynamic Review that never follow a redirect (#197).

`urllib`'s default opener follows 3xx and resends the request — headers included — to the new
location. For the workspace credential that is a leak, and for the engine's own API it is a way to
leave loopback. Every Dynamic Review client uses this opener: a redirect is an HTTP error answer and
is never followed.
"""

from typing import Any
from urllib.request import HTTPRedirectHandler, OpenerDirector, ProxyHandler, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        # Returning None makes urllib raise the 3xx as an HTTPError instead of issuing a request.
        return None


def no_redirect_opener(*, direct: bool = False) -> OpenerDirector:
    """An opener that refuses redirects. `direct` also ignores `HTTP_PROXY`-style variables: calls
    to the engine on loopback must never be routed through a proxy of the runner's environment."""
    if direct:
        return build_opener(ProxyHandler({}), _NoRedirect)
    return build_opener(_NoRedirect)
