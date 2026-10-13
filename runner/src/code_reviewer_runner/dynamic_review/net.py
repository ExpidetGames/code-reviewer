# SPDX-License-Identifier: Apache-2.0

"""A loopback/upstream HTTP opener that never follows a redirect (#197).

`urllib`'s default opener follows 3xx and resends the request — headers included — to the new
location. For the workspace credential that is a leak, and for the engine's own API it is a way to
leave loopback. Every Dynamic Review client uses this opener: a redirect is an HTTP error answer and
is never followed.
"""

from typing import Any
from urllib.request import HTTPRedirectHandler, OpenerDirector, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        # Returning None makes urllib raise the 3xx as an HTTPError instead of issuing a request.
        return None


def no_redirect_opener() -> OpenerDirector:
    return build_opener(_NoRedirect)
