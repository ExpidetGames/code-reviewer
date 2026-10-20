# SPDX-License-Identifier: Apache-2.0

"""The `Upstream` seam over plain http on loopback, for the integration and engine tests (#550).

The production upstream speaks https to a public address and refuses anything else
(`HttpsUpstream`), so a test that runs the real proxy against the generic fakes of `fakes/wire`
(plain http, loopback) puts this behind the same seam. It is a test double, never imported by the
runner; everything else of the proxy is the production code. Not a test file.
"""

import http.client
from urllib.parse import urlsplit

from code_reviewer_runner.dynamic_review.passthrough.upstream import (
    HttpUpstreamResponse,
    UpstreamError,
    UpstreamFailure,
    UpstreamRequest,
    UpstreamResponse,
)


class LoopbackUpstream:
    def __init__(self, base_url: str) -> None:
        parts = urlsplit(base_url)
        assert parts.hostname in ("127.0.0.1", "::1", "localhost"), "loopback only"
        self._host, self._port = parts.hostname or "127.0.0.1", parts.port or 80
        self._base_path = parts.path.rstrip("/")
        self.sent = 0

    def send(self, request: UpstreamRequest, timeout: float) -> UpstreamResponse:
        self.sent += 1
        connection = http.client.HTTPConnection(self._host, self._port, timeout=timeout)
        try:
            connection.request(
                "POST",
                self._base_path + request.path,
                body=request.body,
                headers=dict(request.headers),
            )
            response = connection.getresponse()
        except TimeoutError:
            connection.close()
            raise UpstreamError(UpstreamFailure.TIMEOUT, sent=True) from None
        except (http.client.HTTPException, OSError):
            connection.close()
            raise UpstreamError(UpstreamFailure.UNREACHABLE) from None
        return HttpUpstreamResponse(connection, response)
