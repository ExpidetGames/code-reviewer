# SPDX-License-Identifier: Apache-2.0

"""Test helper, not a test: a GitHub issue-comment API on loopback (#199).

It speaks the three routes the narrow Dynamic client uses, so the publisher runs against a real
socket with the real `HttpCommentsClient`. It records every request and can be scripted to answer a
404/401/403/429/503 or to accept a create and then lose the answer, which is what a retry must
survive.
"""

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import parse_qs, urlsplit

_COMMENTS = re.compile(r"/repos/[^/]+/[^/]+/issues/[0-9]+/comments")
_COMMENT = re.compile(r"/repos/[^/]+/[^/]+/issues/comments/([0-9]+)")


class FakeGithubComments:
    def __init__(self, *, token: str, bot_login: str = "code-reviewer[bot]") -> None:
        self.token = token
        self.bot_login = bot_login
        self.comments: list[dict[str, Any]] = []
        self.requests: list[tuple[str, str]] = []
        self.faults: dict[str, tuple[int, dict[str, str]]] = {}
        self.ambiguous_create = False
        self._next_id = 1
        self._server: ThreadingHTTPServer | None = None
        self._lock = threading.Lock()
        self.url = ""
        self.start()

    def start(self) -> None:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                fake._route("GET", self)

            def do_POST(self) -> None:
                fake._route("POST", self)

            def do_PATCH(self) -> None:
                fake._route("PATCH", self)

            def log_message(self, format: str, *args: Any) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        ).start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def seed(self, body: str, *, author: str | None = None) -> dict[str, Any]:
        with self._lock:
            return self._create(body, author or self.bot_login)

    # -- internals ----------------------------------------------------------------------------

    def _create(self, body: str, author: str) -> dict[str, Any]:
        comment_id = self._next_id
        self._next_id += 1
        comment = {
            "id": comment_id,
            "body": body,
            "user": {"login": author},
            "html_url": f"{self.url}/comment/{comment_id}",
            "updated_at": "2026-10-13T12:00:00Z",
        }
        self.comments.append(comment)
        return comment

    def _route(self, method: str, request: BaseHTTPRequestHandler) -> None:
        parsed = urlsplit(request.path)
        with self._lock:
            self.requests.append((method, request.path))
            fault = self.faults.pop(method, None)
            if request.headers.get("Authorization") != f"Bearer {self.token}":
                _reply(request, 401, {"message": "bad token"})
                return
            if fault is not None:
                _reply(request, fault[0], {"message": "scripted"}, fault[1])
                return
            if method == "GET" and _COMMENTS.fullmatch(parsed.path):
                query = parse_qs(parsed.query)
                per_page = int(query.get("per_page", ["30"])[0])
                page = int(query.get("page", ["1"])[0])
                start = (page - 1) * per_page
                _reply(request, 200, self.comments[start : start + per_page])
                return
            if method == "POST" and _COMMENTS.fullmatch(parsed.path):
                body = _body(request)
                created = self._create(str(body.get("body", "")), self.bot_login)
                if self.ambiguous_create:
                    # The write landed, the answer was lost: a 503 with the comment already there.
                    self.ambiguous_create = False
                    _reply(request, 503, {"message": "lost"})
                    return
                _reply(request, 201, created)
                return
            edit = _COMMENT.fullmatch(parsed.path)
            if method == "PATCH" and edit is not None:
                comment_id = int(edit.group(1))
                for comment in self.comments:
                    if comment["id"] == comment_id:
                        comment["body"] = str(_body(request).get("body", ""))
                        _reply(request, 200, comment)
                        return
                _reply(request, 404, {"message": "no comment"})
                return
            _reply(request, 404, {"message": "no route"})


def _reply(
    request: BaseHTTPRequestHandler, status: int, body: Any, headers: dict[str, str] | None = None
) -> None:
    payload = json.dumps(body).encode("utf-8")
    request.send_response(status)
    request.send_header("Content-Type", "application/json")
    request.send_header("Content-Length", str(len(payload)))
    for key, value in (headers or {}).items():
        request.send_header(key, value)
    request.end_headers()
    request.wfile.write(payload)


def _body(request: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(request.headers.get("Content-Length", "0"))
    raw = request.rfile.read(length) if length else b""
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}
