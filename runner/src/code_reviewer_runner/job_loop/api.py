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
import json
import re
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from code_reviewer_runner import __version__
from code_reviewer_runner.capabilities import ENGINE_DIFF
from code_reviewer_runner.job_loop.http import (
    MAX_RETRY_AFTER_SECONDS,
    ApiError,
    ApiRejected,
    ApiUnavailable,
    LeaseLost,
    Reply,
    build_opener,
    error_code,
    parse_json,
    retry_after,
    send,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object

_JOB_ID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# A heartbeat interval above this would let the 2 minute lease run out between two beats.
MAX_HEARTBEAT_INTERVAL_SECONDS = 60


# The errors and the reply type live in http.py (the Worker API client uses them too); they are
# part of this module's interface as before.
__all__ = [
    "CLAIM_FEATURES",
    "MAX_HEARTBEAT_INTERVAL_SECONDS",
    "MAX_RETRY_AFTER_SECONDS",
    "ApiError",
    "ApiRejected",
    "ApiUnavailable",
    "ClaimedJob",
    "CompleteReply",
    "HeartbeatReply",
    "HttpRunnerApi",
    "LeaseLost",
    "RunnerApi",
]

# What this runner understands beyond its engines (ClaimRequest.features in the contract).
# `supersede` (#396): it stops gracefully when a heartbeat answers `job.superseded`.
CLAIM_FEATURES: tuple[str, ...] = ("dynamic_capabilities", "supersede")


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


@dataclass(frozen=True)
class HeartbeatReply:
    """What the app said to a heartbeat that it accepted."""

    # #396: a newer push replaced this run; it must stop gracefully. Absent in the answer means
    # False.
    superseded: bool = False


def parse_heartbeat(reply: Reply, job_id: str) -> HeartbeatReply:
    """The accepted heartbeat: a 200 is the app's "yes" only as the contract's answer for this very
    job.

    A gateway or a captive portal that answers 200 to everything is not the app (#260). `superseded`
    counts only as the boolean `true`; anything else is "not superseded".
    """
    body = as_object(parse_json(reply))
    job = as_object(body.get("job")) if body and body.get("version") == 1 else None
    if job is None or job.get("id") != job_id:
        raise ApiUnavailable("the heartbeat answer does not match the contract", 200)
    return HeartbeatReply(superseded=job.get("superseded") is True)


class RunnerApi(Protocol):
    async def claim(self) -> ClaimedJob | None: ...

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply: ...

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> CompleteReply: ...


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
        self._opener = build_opener()

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

    async def heartbeat(self, job_id: str, lease_token: str) -> HeartbeatReply:
        reply = await asyncio.to_thread(
            self._send, f"/jobs/{self._safe_id(job_id)}/heartbeat", {"leaseToken": lease_token}
        )
        if reply.status != 200:
            raise self._failure(reply)
        return parse_heartbeat(reply, job_id)

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
        body = as_object(parse_json(reply))
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

    def _send(self, path: str, body: Mapping[str, Any] | None) -> Reply:
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
        return send(self._opener, request, self._timeout)

    @staticmethod
    def _failure(reply: Reply) -> ApiError:
        status = reply.status
        code = error_code(reply)
        if status in (409, 404):
            return LeaseLost(f"the app says the job is not held (HTTP {status})", status)
        if status >= 500 or status in (401, 408, 425, 429):
            return ApiUnavailable(
                f"the app cannot serve the request (HTTP {status})",
                status,
                retry_after(reply.headers),
            )
        if 300 <= status < 400:
            return ApiUnavailable(f"the app answered with a redirect (HTTP {status})", status)
        return ApiRejected(f"the app refused the request (HTTP {status})", status, code)

    @staticmethod
    def _parse_claim(reply: Reply) -> ClaimedJob:
        body = as_object(parse_json(reply))
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
