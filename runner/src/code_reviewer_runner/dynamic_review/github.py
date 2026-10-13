# SPDX-License-Identifier: Apache-2.0

"""The narrow GitHub client the Dynamic publisher writes through (#199).

Only three calls exist, all on issue comments of one pull request: page through them, create one and
edit one. Nothing else — no reviews, no labels, no inline comments, no pull-request edits. The
client holds the job's narrowed installation token, refuses redirects (a redirect would carry the
token elsewhere) and bounds every response.

A failure is turned into a stable error code the caller branches on; the error text never carries a
value from the request or the response, because they hold the token.
"""

import http.client
import json
import re
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol, cast

from code_reviewer_runner.result import ErrorCode

MAX_RESPONSE_BYTES = 1024 * 1024
MAX_COMMENT_PAGES = 50
PER_PAGE = 100
# A comment body GitHub accepts. The renderer stays below this; the client refuses to send more.
MAX_BODY_BYTES = 64 * 1024

_REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


class GitHubError(Exception):
    """A GitHub call that did not succeed. `code` is stable; `detail` names a call, not a value."""

    def __init__(self, code: ErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Comment:
    id: str
    body: str
    author: str
    url: str
    updated_at: str


class CommentsClient(Protocol):
    """The three calls the publisher needs, so a test can replace them with a double."""

    def list_comments(self, pr_number: int) -> list[Comment]: ...

    def create_comment(self, pr_number: int, body: str) -> Comment: ...

    def edit_comment(self, comment_id: str, body: str) -> Comment: ...


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # type: ignore[override]
        return None


@dataclass(frozen=True)
class _Reply:
    status: int
    headers: Mapping[str, str]
    body: bytes


class HttpCommentsClient:
    """`CommentsClient` over the GitHub REST API, with the job's installation token."""

    def __init__(
        self,
        base_url: str,
        repository: str,
        token: str,
        *,
        request_timeout: float = 30.0,
    ) -> None:
        if not _REPOSITORY.fullmatch(repository):
            raise GitHubError(ErrorCode.GIT_PROVIDER_INIT, "the repository name is not owner/repo")
        self._base_url = base_url.rstrip("/")
        self._repository = repository
        self._token = token
        self._timeout = request_timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirects)

    # -- the three calls ----------------------------------------------------------------------

    def list_comments(self, pr_number: int) -> list[Comment]:
        comments: list[Comment] = []
        for page in range(1, MAX_COMMENT_PAGES + 1):
            reply = self._send(
                "GET",
                f"/repos/{self._repository}/issues/{pr_number}/comments"
                f"?per_page={PER_PAGE}&page={page}",
            )
            batch = _comments(_json(reply))
            comments.extend(batch)
            if len(batch) < PER_PAGE:
                return comments
        raise GitHubError(ErrorCode.GIT_UNAVAILABLE, "the pull request has too many comments")

    def create_comment(self, pr_number: int, body: str) -> Comment:
        _check_body(body)
        reply = self._send(
            "POST",
            f"/repos/{self._repository}/issues/{pr_number}/comments",
            {"body": body},
        )
        comment = _comment(_json(reply))
        if comment is None:
            raise GitHubError(ErrorCode.GIT_UNAVAILABLE, "the created comment is malformed")
        return comment

    def edit_comment(self, comment_id: str, body: str) -> Comment:
        if not re.fullmatch(r"[0-9]{1,32}", comment_id):
            raise GitHubError(ErrorCode.GIT_PROVIDER_INIT, "the comment id is not a number")
        _check_body(body)
        reply = self._send(
            "PATCH",
            f"/repos/{self._repository}/issues/comments/{comment_id}",
            {"body": body},
        )
        comment = _comment(_json(reply))
        if comment is None:
            raise GitHubError(ErrorCode.GIT_UNAVAILABLE, "the edited comment is malformed")
        return comment

    # -- internals ----------------------------------------------------------------------------

    def _send(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> _Reply:
        data = (
            json.dumps(body, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            if body is not None
            else None
        )
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "code-reviewer-runner",
                "Content-Type": "application/json",
            },
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return _Reply(
                    response.status, dict(response.headers), response.read(MAX_RESPONSE_BYTES)
                )
        except urllib.error.HTTPError as error:
            code = _code_for(error.code, dict(error.headers))
            raise GitHubError(code, f"GitHub answered HTTP {error.code}") from None
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
            raise GitHubError(
                ErrorCode.GIT_UNAVAILABLE, f"no answer from GitHub ({type(error).__name__})"
            ) from None


def _check_body(body: str) -> None:
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise GitHubError(
            ErrorCode.REVIEW_TEXT_TRUNCATED, "the comment body is over the size limit"
        )


def _code_for(status: int, headers: Mapping[str, str]) -> ErrorCode:
    if status == 401:
        return ErrorCode.GIT_AUTH
    if status == 404:
        return ErrorCode.PR_NOT_FOUND
    if status == 422:
        return ErrorCode.GIT_UNPROCESSABLE
    if status == 429:
        return ErrorCode.GIT_RATE_LIMIT
    if status == 403:
        # GitHub uses 403 both for a permission problem and for a rate limit.
        if headers.get("X-RateLimit-Remaining") == "0" or "Retry-After" in headers:
            return ErrorCode.GIT_RATE_LIMIT
        return ErrorCode.GIT_FORBIDDEN
    return ErrorCode.GIT_UNAVAILABLE


def _json(reply: _Reply) -> Any:
    try:
        return json.loads(reply.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _comment(value: Any) -> Comment | None:
    if not isinstance(value, dict):
        return None
    data = cast("dict[str, Any]", value)
    comment_id = data.get("id")
    body = data.get("body")
    user = data.get("user")
    author = cast("dict[str, Any]", user).get("login") if isinstance(user, dict) else None
    url = data.get("html_url")
    updated_at = data.get("updated_at")
    if (
        isinstance(comment_id, bool)
        or not isinstance(comment_id, int)
        or not isinstance(body, str)
        or not isinstance(author, str)
        or not isinstance(url, str)
        or not url
    ):
        return None
    return Comment(
        id=str(comment_id),
        body=body,
        author=author,
        url=url,
        updated_at=updated_at if isinstance(updated_at, str) else "",
    )


def _comments(value: Any) -> list[Comment]:
    if not isinstance(value, list):
        return []
    found: list[Comment] = []
    for entry in cast("list[Any]", value):
        comment = _comment(entry)
        if comment is not None:
            found.append(comment)
    return found
