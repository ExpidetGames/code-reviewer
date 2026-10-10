"""Manual run of the runner against a real pull request (CR-10-T12), the proof of the spike.

Creates a GitHub App JWT from the private key, exchanges it for an installation token, builds the
job and starts the runner entry point (`code-reviewer-run-job`) as a real process with the job on
stdin. Prints the result JSON of the runner and a summary. Neither the installation token nor the
LLM key is ever printed: the script checks the streams of the runner for both before it prints them.

Needs these environment variables, loaded from the developer's env file with `set -a; . <file>;
set +a`:
GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH,
OPENROUTER_API_KEY.

    uv run python scripts/manual_review.py [--pr-url URL] [--command review] [--model MODEL]
        [--no-identity-patch]   # control run: the runner without the identity patch (CR-11-T05)

It only talks to the sandbox repository below, on purpose: it posts a real comment and costs real
money. Nothing runs without `--yes`. The installation token is limited to that one repository and to
the permissions a review needs (read contents, write pull requests). The cost is not capped by the
script: a review of a small pull request with a cheap model is a few cents; the spending limit
of the OpenRouter key is the hard cap.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import jwt

ALLOWED_REPOSITORY = "ExpidetGames/code-reviewer-playground"
# What a review needs; the token gets nothing else (metadata read is always included).
TOKEN_PERMISSIONS = {"contents": "read", "pull_requests": "write"}
DEFAULT_PR_URL = f"https://github.com/{ALLOWED_REPOSITORY}/pull/1"
DEFAULT_MODEL = "deepseek/deepseek-v3.2"
# Context window of the default model; PR-Agent does not know it and needs it for unknown models.
DEFAULT_MAX_TOKENS = 163840
GITHUB_API = "https://api.github.com"
REQUIRED_ENV = (
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY_PATH",
    "OPENROUTER_API_KEY",
)


def create_app_jwt(app_id: str, private_key_pem: str, now: float | None = None) -> str:
    """The JWT an App uses to authenticate as itself (valid for at most 10 minutes)."""
    issued = int(now if now is not None else time.time())
    claims = {"iat": issued - 60, "exp": issued + 9 * 60, "iss": app_id}
    return jwt.encode(claims, private_key_pem, algorithm="RS256")


def token_request_body() -> dict[str, Any]:
    """Limit the token to the sandbox repository and the permissions of a review."""
    return {
        "repositories": [ALLOWED_REPOSITORY.split("/", 1)[1]],
        "permissions": dict(TOKEN_PERMISSIONS),
    }


def mint_installation_token(app_id: str, installation_id: str, key_path: Path) -> str:
    """Exchange the App JWT for an installation access token. The token is only returned."""
    app_jwt = create_app_jwt(app_id, key_path.read_text())
    request = urllib.request.Request(
        f"{GITHUB_API}/app/installations/{installation_id}/access_tokens",
        method="POST",
        data=json.dumps(token_request_body()).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {app_jwt}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "code-reviewer-manual-review",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload: dict[str, Any] = json.load(response)
    return str(payload["token"])


def check_repository(pr_url: str) -> None:
    match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+)/pull/[1-9][0-9]*", pr_url)
    if match is None or match.group(1) != ALLOWED_REPOSITORY:
        raise SystemExit(f"refusing to run: only pull requests of {ALLOWED_REPOSITORY} are allowed")


def build_job(
    pr_url: str, command: str, token: str, bot_login: str, api_key: str, model: str, max_tokens: int
) -> dict[str, Any]:
    return {
        "prUrl": pr_url,
        "command": command,
        "git": {
            "provider": "github",
            "baseUrl": GITHUB_API,
            "token": token,
            "botLogin": bot_login,
        },
        "llm": {
            "provider": "openrouter",
            "model": model,
            "apiKey": api_key,
            "maxTokens": max_tokens,
        },
    }


# Control run for CR-11-T05: the same entry point, but the identity patch is replaced by a no-op, so
# PR-Agent behaves as it would with the stock login lookup (GET /user, which an installation token
# cannot do).
CONTROL_SNIPPET = (
    "import sys; from code_reviewer_runner import runner; "
    "runner.apply_identity_patch = lambda login: (lambda: None); sys.exit(runner.main([]))"
)


def runner_command(*, identity_patch: bool) -> list[str]:
    if identity_patch:
        return [str(Path(sys.executable).parent / "code-reviewer-run-job")]
    return [sys.executable, "-I", "-c", CONTROL_SNIPPET]


def start_runner(
    job: Mapping[str, Any], identity_patch: bool = True
) -> subprocess.CompletedProcess[str]:
    environment = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}
    return subprocess.run(
        runner_command(identity_patch=identity_patch),
        input=json.dumps(job),
        capture_output=True,
        text=True,
        env=environment,
        timeout=20 * 60,
        check=False,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--pr-url", default=DEFAULT_PR_URL)
    parser.add_argument("--command", default="review")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    parser.add_argument(
        "--no-identity-patch",
        action="store_true",
        help="control run for the spike: start the runner without the identity patch",
    )
    parser.add_argument(
        "--yes", action="store_true", help="really run (posts a comment, costs money)"
    )
    args = parser.parse_args(argv)

    check_repository(args.pr_url)
    if not args.yes:
        print(f"Would run `{args.command}` on {args.pr_url} with {args.model}.")
        print("That posts a real comment and costs real money (a few cents); add --yes to run.")
        return 2
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"missing environment variables: {', '.join(missing)}")

    token = mint_installation_token(
        os.environ["GITHUB_APP_ID"],
        os.environ["GITHUB_APP_INSTALLATION_ID"],
        Path(os.environ["GITHUB_APP_PRIVATE_KEY_PATH"]),
    )
    api_key = os.environ["OPENROUTER_API_KEY"]
    job = build_job(
        args.pr_url,
        args.command,
        token,
        os.environ["GITHUB_APP_SLUG"],
        api_key,
        args.model,
        args.max_tokens,
    )
    started = time.monotonic()
    process = start_runner(job, identity_patch=not args.no_identity_patch)
    wall_seconds = time.monotonic() - started

    leaked = [
        name
        for name, secret in (("installation token", token), ("LLM key", api_key))
        for stream in (process.stdout, process.stderr)
        if secret in stream
    ]
    if leaked:
        print(f"SECRET SCAN FAILED: {', '.join(sorted(set(leaked)))} found in the runner output")
        return 2
    print(process.stdout.strip())
    if process.stderr.strip():
        print("--- stderr ---")
        print(process.stderr.strip())
    print(f"--- exit code {process.returncode}, wall time {wall_seconds:.1f}s, model {args.model}")
    print("--- secret scan of stdout and stderr: clean (installation token, LLM key)")
    return process.returncode


if __name__ == "__main__":
    sys.exit(main())
