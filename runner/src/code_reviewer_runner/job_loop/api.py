# SPDX-License-Identifier: Apache-2.0

"""The runner's side of the runner API (`contracts/runner-api.v1.json`).

Three calls: `claim` (200 with a job, 204 for none), `heartbeat` and `complete`. What a caller has
to tell apart is small, so the errors are too:

- `ApiUnavailable`: the app cannot answer now (no connection, 5xx, 429, a wrong token, an answer
  that is not the contract). The caller waits and tries again.
- `LeaseLost`: the app says the runner no longer holds the job (409, or 404). Nothing more may be
  sent for it.
- `ApiRejected`: the app refused this request for good (another 4xx). Retrying the same request
  cannot help.

No error carries a value of the request or the response: they hold secrets.
"""

import asyncio
import http.client
import json
import re
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from code_reviewer_runner import __version__
from code_reviewer_runner.capabilities import ENGINE_DIFF
from code_reviewer_runner.job_loop.jsonvalues import as_object

_JOB_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
MAX_RESPONSE_BYTES = 1024 * 1024
# A heartbeat interval above this would let the 2 minute lease run out between two beats.
MAX_HEARTBEAT_INTERVAL_SECONDS = 60
MAX_RETRY_AFTER_SECONDS = 15 * 60


# What this runner understands beyond its engines (ClaimRequest.features in the contract).
CLAIM_FEATURES: tuple[str, ...] = ("dynamic_capabilities",)


class ApiError(Exception):
    """Base of the errors below. `status` is the HTTP status, or None without an answer."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class ApiUnavailable(ApiError):
    def __init__(
        self, message: str, status: int | None = None, retry_after: float | None = None
    ) -> None:
        super().__init__(message, status)
        self.retry_after = retry_after


class LeaseLost(ApiError):
    pass


class ApiRejected(ApiError):
    def __init__(self, message: str, status: int, code: str | None) -> None:
        super().__init__(message, status)
        self.code = code


@dataclass(frozen=True)
class ClaimedJob:
    id: str
    lease_token: str
    heartbeat_interval: float
    input: dict[str, Any]


@dataclass(frozen=True)
class CompleteReply:
    # "succeeded" or "failed": finished. "queued": given back after runner_shutdown. None: unknown.
    status: str | None
    already_completed: bool


class RunnerApi(Protocol):
    async def claim(self) -> ClaimedJob | None: ...

    async def heartbeat(self, job_id: str, lease_token: str) -> None: ...

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply: ...


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect would carry the token to wherever it points: refuse it instead."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        return None


@dataclass(frozen=True)
class _Reply:
    status: int
    headers: Mapping[str, str]
    body: bytes


def _retry_after(headers: Mapping[str, str]) -> float | None:
    raw = headers.get("Retry-After")
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return min(max(seconds, 0.0), MAX_RETRY_AFTER_SECONDS) if seconds == seconds else None


def _json(reply: _Reply) -> Any:
    try:
        return json.loads(reply.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _error_code(reply: _Reply) -> str | None:
    body = as_object(_json(reply))
    error = as_object(body.get("error")) if body else None
    code = error.get("code") if error else None
    if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,64}", code):
        return code
    return None


class HttpRunnerApi:
    """The runner API over HTTP. Blocking calls run in a thread, so the loop stays responsive."""

    def __init__(
        self,
        base_url: str,
        token: str,
        runner_id: str,
        *,
        engines: tuple[str, ...] = (ENGINE_DIFF,),
        request_timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._runner_id = runner_id
        self._engines = engines or (ENGINE_DIFF,)
        self._timeout = request_timeout
        # No proxy: the token must only go to the app, and the app is reached directly.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects)

    # -- the three calls ----------------------------------------------------------------------

    async def claim(self) -> ClaimedJob | None:
        # #195: the engines this runner can run. A previous-release runner sends no body; this one
        # advertises what its startup self-check proved.
        # #279: `features` says what else this runner reads, so an app sends a job's optional fields
        # (the model capabilities of a Dynamic job) only to a runner that understands them; a
        # previous-release runner names none and an app from before ignores the key.
        reply = await asyncio.to_thread(
            self._send,
            "/claim",
            {"engines": list(self._engines), "features": list(CLAIM_FEATURES)},
        )
        if reply.status == 204:
            return None
        if reply.status != 200:
            raise self._failure(reply)
        return self._parse_claim(reply)

    async def heartbeat(self, job_id: str, lease_token: str) -> None:
        reply = await asyncio.to_thread(
            self._send, f"/jobs/{self._safe_id(job_id)}/heartbeat", {"leaseToken": lease_token}
        )
        if reply.status != 200:
            raise self._failure(reply)
        # #260: a 200 is the app's "yes" only as the contract's answer for this very job. A gateway
        # or a captive portal that answers 200 to everything is not the app.
        body = as_object(_json(reply))
        job = as_object(body.get("job")) if body and body.get("version") == 1 else None
        if job is None or job.get("id") != job_id:
            raise ApiUnavailable("the heartbeat answer does not match the contract", 200)

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply:
        reply = await asyncio.to_thread(
            self._send,
            f"/jobs/{self._safe_id(job_id)}/complete",
            {"leaseToken": lease_token, "result": dict(result)},
        )
        if reply.status != 200:
            raise self._failure(reply)
        body = as_object(_json(reply))
        job = as_object(body.get("job")) if body else None
        status = job.get("status") if job else None
        return CompleteReply(
            status=status if isinstance(status, str) else None,
            already_completed=bool(body and body.get("alreadyCompleted") is True),
        )

    # -- internals ----------------------------------------------------------------------------

    @staticmethod
    def _safe_id(job_id: str) -> str:
        if not _JOB_ID.fullmatch(job_id):
            raise ApiRejected("the job id is not a UUID", 400, None)
        return job_id

    def _send(self, path: str, body: Mapping[str, Any] | None) -> _Reply:
        data = json.dumps(body, separators=(",", ":")).encode("ascii") if body is not None else b""
        request = urllib.request.Request(
            f"{self._base_url}/api/runners/v1{path}",
            data=data,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._token}",
                "X-Runner-Id": self._runner_id,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": f"code-reviewer-runner/{__version__}",
            },
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return _Reply(
                    response.status, dict(response.headers), response.read(MAX_RESPONSE_BYTES)
                )
        except urllib.error.HTTPError as error:
            try:
                body_bytes = error.read(MAX_RESPONSE_BYTES)
            except Exception:
                body_bytes = b""
            return _Reply(error.code, dict(error.headers), body_bytes)
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
            # The class of the error is enough: its text can hold the URL.
            raise ApiUnavailable(f"no answer from the app ({type(error).__name__})") from None

    @staticmethod
    def _failure(reply: _Reply) -> ApiError:
        status = reply.status
        code = _error_code(reply)
        if status in (409, 404):
            return LeaseLost(f"the app says the job is not held (HTTP {status})", status)
        if status >= 500 or status in (401, 408, 425, 429):
            return ApiUnavailable(
                f"the app cannot serve the request (HTTP {status})",
                status,
                _retry_after(reply.headers),
            )
        if 300 <= status < 400:
            return ApiUnavailable(f"the app answered with a redirect (HTTP {status})", status)
        return ApiRejected(f"the app refused the request (HTTP {status})", status, code)

    @staticmethod
    def _parse_claim(reply: _Reply) -> ClaimedJob:
        body = as_object(_json(reply))
        job = as_object(body.get("job")) if body and body.get("version") == 1 else None
        job_id = job.get("id") if job else None
        lease_token = job.get("leaseToken") if job else None
        interval = job.get("heartbeatIntervalSeconds") if job else None
        job_input = as_object(job.get("input")) if job else None
        if (
            not isinstance(job_id, str)
            or not _JOB_ID.fullmatch(job_id)
            or not isinstance(lease_token, str)
            or not 8 <= len(lease_token) <= 256
            or not isinstance(interval, int)
            or isinstance(interval, bool)
            or interval < 1
            or job_input is None
        ):
            # The job may be held now, but the lease cannot be used without these fields.
            raise ApiUnavailable("the claim answer does not match the contract", 200)
        return ClaimedJob(
            id=job_id,
            lease_token=lease_token,
            heartbeat_interval=float(min(interval, MAX_HEARTBEAT_INTERVAL_SECONDS)),
            input=job_input,
        )
