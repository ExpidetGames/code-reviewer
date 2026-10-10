"""A fake GitHub for the engine suite: the REST and GraphQL calls PR-Agent's GitHub provider makes.

One real HTTP server on a loopback port, spoken to by PyGithub exactly as it speaks to GitHub
Enterprise (`GITHUB__BASE_URL=http://127.0.0.1:<port>/api/v3`). It knows one repository with one
pull request, keeps the comments that were posted, and records every request (method, path, the
Authorization header) so a test can assert what PR-Agent asked for and where the token went.

It behaves like GitHub with an installation token: `GET /user` answers 403 ("Resource not accessible
by integration"), which is the reason the runner patches PR-Agent's identity lookup. Faults (a 404
for the pull request, a 500 for writing a comment) are switched on per test. Dummy data only.

Not modelled on purpose: inline review comments, reviews, labels, check runs and pagination (every
list comes back whole), because the commands the engine suite runs do not use them.
"""

import base64
import json
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

API_PREFIX = "/api/v3"
# GitHub refuses a comment longer than this with a 422.
MAX_COMMENT_CHARS = 65536
BOT_LOGIN = "code-reviewer[bot]"
_NOW = "2026-10-10T12:00:00Z"


@dataclass(frozen=True)
class ChangedFile:
    """A file of the pull request: its diff and the text on both sides."""

    filename: str
    base_content: str
    head_content: str
    patch: str
    status: str = "modified"

    @property
    def additions(self) -> int:
        return sum(1 for line in self.patch.splitlines() if line.startswith("+"))

    @property
    def deletions(self) -> int:
        return sum(1 for line in self.patch.splitlines() if line.startswith("-"))


@dataclass
class RecordedRequest:
    method: str
    path: str  # without the API prefix and the query
    query: dict[str, list[str]]
    authorization: str
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body or b"null")


@dataclass
class Comment:
    id: int
    body: str
    login: str
    created_at: str = _NOW
    updated_at: str = _NOW


@dataclass
class Fault:
    """Answer matching requests with an error status. `times` None means for ever."""

    method: str
    pattern: re.Pattern[str]
    status: int
    message: str = "Server Error"
    times: int | None = None


@dataclass
class FakeGithub:
    owner: str = "octo"
    repo: str = "widgets"
    number: int = 7
    token: str = "dummy-installation-token-0123456789"
    title: str = "Add a greeting helper"
    body: str = ""
    default_branch: str = "main"
    files: list[ChangedFile] = field(default_factory=lambda: [default_file()])
    # Files of the repository by (path, ref): `.pr_agent.toml` and `AGENTS.md` of the base branch.
    repo_files: dict[tuple[str, str], str] = field(default_factory=lambda: {})
    comments: list[Comment] = field(default_factory=lambda: [])
    requests: list[RecordedRequest] = field(default_factory=lambda: [])
    faults: list[Fault] = field(default_factory=lambda: [])
    # The host answers errors the way real ones do: a message that may quote what was sent.
    echo_token_in_errors: bool = False
    # Text of the PR description after PATCH, and how often the pull request was patched.
    patched_bodies: list[str] = field(default_factory=lambda: [])
    patched_titles: list[str] = field(default_factory=lambda: [])
    # How many comment writes were refused for being longer than GitHub takes.
    refused_too_long: int = 0
    head_sha: str = "1" * 40
    base_sha: str = "2" * 40

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._next_comment_id = 4000
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:  # silence the test output
                return

            def do_GET(self) -> None:
                fake._handle(self)

            do_POST = do_PATCH = do_DELETE = do_PUT = do_GET

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=10)

    @property
    def port(self) -> int:
        assert self._server is not None
        return int(self._server.server_address[1])

    @property
    def host(self) -> str:
        return f"127.0.0.1:{self.port}"

    @property
    def base_url(self) -> str:
        """`git.baseUrl` of a job."""
        return f"http://{self.host}{API_PREFIX}"

    @property
    def pr_url(self) -> str:
        """`prUrl` of a job: on the host of `base_url`, as the runner demands."""
        return f"http://{self.host}/{self.owner}/{self.repo}/pull/{self.number}"

    # ------------------------------------------------------------------ test API

    def add_comment(self, body: str, login: str = BOT_LOGIN) -> Comment:
        with self._lock:
            return self._new_comment(body, login)

    def fail(
        self,
        method: str,
        pattern: str,
        status: int,
        message: str = "Server Error",
        times: int | None = None,
    ) -> None:
        self.faults.append(Fault(method.upper(), re.compile(pattern), status, message, times))

    def requests_to(self, method: str, pattern: str) -> list[RecordedRequest]:
        regex = re.compile(pattern)
        with self._lock:
            return [r for r in self.requests if r.method == method and regex.fullmatch(r.path)]

    def comment_url(self, comment: Comment) -> str:
        return f"http://{self.host}/{self.owner}/{self.repo}/pull/{self.number}#issuecomment-{comment.id}"

    # ------------------------------------------------------------------ request handling

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        split = urlsplit(handler.path)
        length = int(handler.headers.get("Content-Length") or 0)
        body = handler.rfile.read(length) if length else b""
        path = split.path.removeprefix(API_PREFIX)
        request = RecordedRequest(
            method=handler.command,
            path=path,
            query=parse_qs(split.query),
            authorization=handler.headers.get("Authorization", ""),
            body=body,
        )
        with self._lock:
            self.requests.append(request)
            status, payload = self._dispatch(request)
        data = b"" if status == 204 else json.dumps(payload).encode()
        handler.send_response(status)
        if data:
            handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def _error(self, status: int, message: str, request: RecordedRequest) -> tuple[int, Any]:
        if self.echo_token_in_errors:
            message = f"{message} (token {request.authorization.split(' ')[-1]})"
        return status, {"message": message, "documentation_url": "https://docs.github.com/rest"}

    def _dispatch(self, request: RecordedRequest) -> tuple[int, Any]:
        sent = request.authorization.split(" ")[-1]
        if sent != self.token:
            return self._error(401, "Bad credentials", request)
        for fault in self.faults:
            if fault.method == request.method and fault.pattern.fullmatch(request.path):
                if fault.times is not None:
                    if fault.times <= 0:
                        continue
                    fault.times -= 1
                return self._error(fault.status, fault.message, request)
        for method, pattern, route in self._routes():
            match = pattern.fullmatch(request.path)
            if method == request.method and match:
                return route(request, *match.groups())
        return self._error(404, "Not Found", request)

    def _routes(self) -> list[tuple[str, re.Pattern[str], Callable[..., tuple[int, Any]]]]:
        repo = rf"/repos/{re.escape(self.owner)}/{re.escape(self.repo)}"
        number = self.number
        table: list[tuple[str, str, Callable[..., tuple[int, Any]]]] = [
            ("GET", "/user", self._user),
            ("GET", "/rate_limit", self._rate_limit),
            ("POST", "/graphql", self._graphql),
            ("GET", repo, self._repository),
            ("GET", rf"{repo}/pulls/{number}", self._pull),
            ("PATCH", rf"{repo}/pulls/{number}", self._patch_pull),
            ("GET", rf"{repo}/pulls/{number}/commits", self._pull_commits),
            ("GET", rf"{repo}/pulls/{number}/files", self._pull_files),
            ("GET", rf"{repo}/pulls/{number}/comments", self._empty_list),
            ("GET", rf"{repo}/pulls/{number}/reviews", self._empty_list),
            ("GET", rf"{repo}/commits/([0-9a-f]+)", self._commit),
            ("GET", rf"{repo}/compare/(.+)", self._compare),
            ("GET", rf"{repo}/branches/([^/]+)", self._branch),
            ("GET", rf"{repo}/languages", self._languages),
            ("GET", rf"{repo}/contents/(.+)", self._contents),
            ("GET", rf"{repo}/issues/{number}", self._issue),
            ("GET", rf"{repo}/issues/{number}/comments", self._list_comments),
            ("POST", rf"{repo}/issues/{number}/comments", self._create_comment),
            ("PATCH", rf"{repo}/issues/comments/([0-9]+)", self._edit_comment),
            ("DELETE", rf"{repo}/issues/comments/([0-9]+)", self._delete_comment),
        ]
        return [(method, re.compile(pattern), route) for method, pattern, route in table]

    # ------------------------------------------------------------------ payloads

    def _web(self, suffix: str = "") -> str:
        return f"http://{self.host}/{self.owner}/{self.repo}{suffix}"

    def _api(self, suffix: str = "") -> str:
        return f"http://{self.host}{API_PREFIX}/repos/{self.owner}/{self.repo}{suffix}"

    def _user_json(self, login: str) -> dict[str, Any]:
        return {"login": login, "id": 1, "type": "Bot" if login.endswith("[bot]") else "User"}

    def _repo_json(self) -> dict[str, Any]:
        return {
            "id": 100,
            "name": self.repo,
            "full_name": f"{self.owner}/{self.repo}",
            "owner": self._user_json(self.owner),
            "private": True,
            "default_branch": self.default_branch,
            "url": self._api(),
            "html_url": self._web(),
        }

    def _branch_ref(self, name: str, sha: str) -> dict[str, Any]:
        return {"label": f"{self.owner}:{name}", "ref": name, "sha": sha, "repo": self._repo_json()}

    def _user(self, request: RecordedRequest) -> tuple[int, Any]:
        # An installation token cannot ask who it is.
        return self._error(403, "Resource not accessible by integration", request)

    def _rate_limit(self, request: RecordedRequest) -> tuple[int, Any]:
        window = {"limit": 5000, "remaining": 4999, "reset": 4102444800, "used": 1}
        return 200, {"resources": {"core": window, "graphql": window}, "rate": window}

    def _graphql(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, {"data": {"repository": {"pullRequest": {"reviewThreads": {"nodes": []}}}}}

    def _repository(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, self._repo_json()

    def _pull(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, {
            "number": self.number,
            "title": self.patched_titles[-1] if self.patched_titles else self.title,
            "body": self.patched_bodies[-1] if self.patched_bodies else self.body,
            "state": "open",
            "draft": False,
            "merged": False,
            "user": self._user_json("alice"),
            "url": self._api(f"/pulls/{self.number}"),
            "html_url": self._web(f"/pull/{self.number}"),
            "issue_url": self._api(f"/issues/{self.number}"),
            "head": self._branch_ref("feature/greeting", self.head_sha),
            "base": self._branch_ref(self.default_branch, self.base_sha),
            "changed_files": len(self.files),
            "commits": 1,
            "labels": [],
            "created_at": _NOW,
            "updated_at": _NOW,
        }

    def _patch_pull(self, request: RecordedRequest) -> tuple[int, Any]:
        data = request.json()
        if "body" in data:
            self.patched_bodies.append(str(data["body"]))
        if "title" in data:
            self.patched_titles.append(str(data["title"]))
        return self._pull(request)

    def _commit_json(self) -> dict[str, Any]:
        author = {"name": "Alice", "email": "alice@example.com", "date": _NOW}
        return {
            "sha": self.head_sha,
            "url": self._api(f"/commits/{self.head_sha}"),
            "html_url": self._web(f"/commit/{self.head_sha}"),
            "commit": {"message": "Add a greeting helper", "author": author, "committer": author},
            "author": self._user_json("alice"),
            "committer": self._user_json("alice"),
            "parents": [{"sha": self.base_sha}],
            "files": [self._file_json(f) for f in self.files],
        }

    def _pull_commits(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, [self._commit_json()]

    def _commit(self, request: RecordedRequest, sha: str) -> tuple[int, Any]:
        return 200, self._commit_json()

    def _compare(self, request: RecordedRequest, spec: str) -> tuple[int, Any]:
        merge_base = {**self._commit_json(), "sha": self.base_sha}
        return 200, {
            "status": "ahead",
            "ahead_by": 1,
            "behind_by": 0,
            "total_commits": 1,
            "merge_base_commit": merge_base,
            "commits": [self._commit_json()],
            "files": [self._file_json(f) for f in self.files],
        }

    def _file_json(self, file: ChangedFile) -> dict[str, Any]:
        return {
            "sha": "3" * 40,
            "filename": file.filename,
            "status": file.status,
            "additions": file.additions,
            "deletions": file.deletions,
            "changes": file.additions + file.deletions,
            "patch": file.patch,
        }

    def _pull_files(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, [self._file_json(f) for f in self.files]

    def _empty_list(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, []

    def _branch(self, request: RecordedRequest, name: str) -> tuple[int, Any]:
        return 200, {"name": name, "commit": {"sha": self.base_sha}}

    def _languages(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, {"Python": 1000}

    def _contents(self, request: RecordedRequest, path: str) -> tuple[int, Any]:
        path = unquote(path)
        ref = request.query.get("ref", [""])[0]
        text = self._file_text(path, ref)
        if text is None:
            return self._error(404, "Not Found", request)
        return 200, {
            "type": "file",
            "name": path.rsplit("/", 1)[-1],
            "path": path,
            "sha": "4" * 40,
            "size": len(text),
            "encoding": "base64",
            "content": base64.b64encode(text.encode()).decode(),
            "url": self._api(f"/contents/{path}"),
            "html_url": self._web(f"/blob/{ref or self.default_branch}/{path}"),
        }

    def _file_text(self, path: str, ref: str) -> str | None:
        """The text of a file at a ref. The head and the base of the pull request have their own."""
        for file in self.files:
            if file.filename == path:
                if ref in (self.head_sha, "feature/greeting"):
                    return file.head_content
                return file.base_content
        if (path, ref) in self.repo_files:
            return self.repo_files[(path, ref)]
        # A file of the repository, asked for without a ref or by the default branch or its sha.
        for known in ("", self.default_branch, self.base_sha):
            if (path, known) in self.repo_files:
                return self.repo_files[(path, known)]
        return None

    def _issue(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, {
            "number": self.number,
            "title": self.title,
            "body": self.body,
            "state": "open",
            "user": self._user_json("alice"),
            "url": self._api(f"/issues/{self.number}"),
            "html_url": self._web(f"/pull/{self.number}"),
            "comments_url": self._api(f"/issues/{self.number}/comments"),
            "pull_request": {"url": self._api(f"/pulls/{self.number}")},
        }

    # ------------------------------------------------------------------ comments

    def _new_comment(self, body: str, login: str) -> Comment:
        self._next_comment_id += 1
        comment = Comment(id=self._next_comment_id, body=body, login=login)
        self.comments.append(comment)
        return comment

    def _comment_json(self, comment: Comment) -> dict[str, Any]:
        return {
            "id": comment.id,
            "body": comment.body,
            "user": self._user_json(comment.login),
            "created_at": comment.created_at,
            "updated_at": comment.updated_at,
            "url": self._api(f"/issues/comments/{comment.id}"),
            "html_url": self.comment_url(comment),
            "issue_url": self._api(f"/issues/{self.number}"),
        }

    def _list_comments(self, request: RecordedRequest) -> tuple[int, Any]:
        return 200, [self._comment_json(c) for c in self.comments]

    def _too_long(self, request: RecordedRequest) -> tuple[int, Any] | None:
        if len(str(request.json().get("body", ""))) <= MAX_COMMENT_CHARS:
            return None
        self.refused_too_long += 1
        return 422, {
            "message": "Validation Failed",
            "errors": [
                {
                    "resource": "IssueComment",
                    "code": "unprocessable",
                    "field": "data",
                    "message": f"Body is too long (maximum is {MAX_COMMENT_CHARS} characters)",
                }
            ],
            "documentation_url": "https://docs.github.com/rest",
        }

    def _create_comment(self, request: RecordedRequest) -> tuple[int, Any]:
        refused = self._too_long(request)
        if refused is not None:
            return refused
        comment = self._new_comment(str(request.json()["body"]), BOT_LOGIN)
        return 201, self._comment_json(comment)

    def _find(self, comment_id: str) -> Comment | None:
        return next((c for c in self.comments if c.id == int(comment_id)), None)

    def _edit_comment(self, request: RecordedRequest, comment_id: str) -> tuple[int, Any]:
        comment = self._find(comment_id)
        if comment is None:
            return self._error(404, "Not Found", request)
        refused = self._too_long(request)
        if refused is not None:
            return refused
        comment.body = str(request.json()["body"])
        comment.updated_at = "2026-10-10T12:05:00Z"
        return 200, self._comment_json(comment)

    def _delete_comment(self, request: RecordedRequest, comment_id: str) -> tuple[int, Any]:
        comment = self._find(comment_id)
        if comment is None:
            return self._error(404, "Not Found", request)
        self.comments.remove(comment)
        return 204, {}


def default_file() -> ChangedFile:
    """A small Python change, enough for PR-Agent to build a prompt from."""
    base = 'def greet(name):\n    return "Hello"\n'
    head = (
        'def greet(name):\n    return f"Hello, {name}!"\n\n\n'
        'def farewell(name):\n    return f"Bye, {name}"\n'
    )
    patch = (
        "@@ -1,2 +1,6 @@\n"
        " def greet(name):\n"
        '-    return "Hello"\n'
        '+    return f"Hello, {name}!"\n'
        "+\n"
        "+\n"
        "+def farewell(name):\n"
        '+    return f"Bye, {name}"\n'
    )
    return ChangedFile("greeting.py", base, head, patch)
