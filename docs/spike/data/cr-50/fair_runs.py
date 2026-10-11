"""Driver of the CR-50 fair model comparison (one run at a time, no shared state between runs).

Per run: (1) delete every review comment of our own GitHub App bot on the pull request (the customer
authorised exactly this for CR-50, nothing else), (2) verify through the API that no bot comment is
left, (3) start `runner/scripts/manual_review.py` for one model and record the result, (4) save the
anonymous copy of the comment and the mapping row.

Nothing else is ever deleted: only issue comments whose author login is exactly the bot login, only
on pull requests 1 to 3 of the private playground repository. The script mints the installation
token like `manual_review.py` and never prints it. Credentials come from the environment
(`set -a; . ~/.config/code-reviewer/dev.env; set +a`).

    python fair_runs.py list                               # read-only: comments per pull request
    python fair_runs.py run --model M --pr N --round R     # one run, with delete + check
    python fair_runs.py plan --seed S                      # print the schedule

Run it with the interpreter of the `runner/` virtual environment so that `manual_review.py` can be
imported.
"""

import argparse
import csv
import json
import os
import random
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO = "ExpidetGames/code-reviewer-playground"
BOT_LOGIN = "code-reviewer-dev-expidetgames[bot]"
PULLS = (1, 2, 3)
MODELS = (
    "anthropic/claude-haiku-5.5",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-opus-5.5",
    "openai/gpt-5.4-mini",
    "google/gemini-3.8-flash",
    "deepseek/deepseek-v3.2",
    "deepseek/deepseek-v4.1-flash",
)
# Words that would identify a model; they are scrubbed from the anonymous copies.
MODEL_WORDS = re.compile(
    r"claude|anthropic|opus|sonnet|haiku|gpt|openai|gemini|deepseek|openrouter",
    re.IGNORECASE,
)

RUNNER_DIR = Path(__file__).resolve().parents[4] / "runner"
sys.path.insert(0, str(RUNNER_DIR / "scripts"))
import manual_review as mr


def api(token: str, method: str, path: str) -> Any:
    request = urllib.request.Request(
        f"{mr.GITHUB_API}{path}", method=method, headers=mr.github_headers(token)
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
            return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if method == "DELETE" and error.code == 404:
                return None  # already gone (a retry after a lost answer)
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def mint_token() -> str:
    for attempt in range(4):
        try:
            return mr.mint_installation_token(
                os.environ["GITHUB_APP_ID"],
                os.environ["GITHUB_APP_INSTALLATION_ID"],
                Path(os.environ["GITHUB_APP_PRIVATE_KEY_PATH"]),
            )
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
    raise AssertionError("unreachable")


def list_issue_comments(token: str, pr: int) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    page = 1
    while True:
        chunk = api(
            token, "GET", f"/repos/{REPO}/issues/{pr}/comments?per_page=100&page={page}"
        )
        comments.extend(chunk)
        if len(chunk) < 100:
            return comments
        page += 1


def bot_comments(token: str, pr: int) -> list[dict[str, Any]]:
    return [
        c for c in list_issue_comments(token, pr) if c["user"]["login"] == BOT_LOGIN
    ]


def other_bot_traces(token: str, pr: int) -> dict[str, int]:
    """Review (inline) comments and reviews by the bot; reported only, never deleted."""
    inline = api(token, "GET", f"/repos/{REPO}/pulls/{pr}/comments?per_page=100")
    reviews = api(token, "GET", f"/repos/{REPO}/pulls/{pr}/reviews?per_page=100")
    return {
        "inlineByBot": sum(1 for c in inline if c["user"]["login"] == BOT_LOGIN),
        "reviewsByBot": sum(1 for r in reviews if r["user"]["login"] == BOT_LOGIN),
    }


def delete_bot_comments(token: str, pr: int) -> dict[str, Any]:
    """Delete our own bot's comments on `pr` and prove that none is left."""
    if pr not in PULLS:
        raise SystemExit(f"refusing: pull request {pr} is not one of {PULLS}")
    if os.environ.get("GITHUB_APP_SLUG", "") + "[bot]" != BOT_LOGIN:
        raise SystemExit(
            "refusing: the app slug does not match the authorised bot login"
        )
    before = list_issue_comments(token, pr)
    mine = [c for c in before if c["user"]["login"] == BOT_LOGIN]
    for comment in mine:
        if comment["user"]["login"] != BOT_LOGIN or comment["user"]["type"] != "Bot":
            raise SystemExit("refusing: not a comment of our own bot")
        api(token, "DELETE", f"/repos/{REPO}/issues/comments/{comment['id']}")
    after = list_issue_comments(token, pr)
    left = [c for c in after if c["user"]["login"] == BOT_LOGIN]
    if left:
        raise SystemExit(f"check failed: {len(left)} bot comment(s) left on #{pr}")
    return {
        "pr": pr,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "commentsBefore": len(before),
        "botCommentsDeleted": [c["id"] for c in mine],
        "commentsAfter": len(after),
        "botCommentsAfter": 0,
        "otherCommentsUntouched": len(before) - len(mine),
        **other_bot_traces(token, pr),
    }


def anonymise(body: str) -> tuple[str, list[str]]:
    """The comment text without model names; also returns what was scrubbed."""
    hits = sorted({m.group(0).lower() for m in MODEL_WORDS.finditer(body)})
    return MODEL_WORDS.sub("[removed]", body), hits


def schedule(seed: int, rounds: int) -> list[dict[str, Any]]:
    """Per round and pull request a random model order (seeded)."""
    rng = random.Random(seed)
    plan = []
    for round_no in range(1, rounds + 1):
        for pr in PULLS:
            order = list(MODELS)
            rng.shuffle(order)
            plan.append({"round": round_no, "pr": pr, "order": order})
    return plan


def label_of(model: str, pr: int, round_no: int) -> str:
    return f"{model.split('/')[1].replace('.', '_')}-pr{pr}-r{round_no}"


def run_one(args: argparse.Namespace) -> int:
    out = Path(args.out)
    records = out / "records"
    label = label_of(args.model, args.pr, args.round) + args.suffix
    token = mint_token()
    mr.check_label(records, label)
    check = delete_bot_comments(token, args.pr)
    records.mkdir(parents=True, exist_ok=True)
    (records / f"{label}.precheck.json").write_text(json.dumps(check, indent=2) + "\n")
    command = [
        sys.executable,
        str(RUNNER_DIR / "scripts" / "manual_review.py"),
        "--yes",
        "--pr-url",
        f"https://github.com/{REPO}/pull/{args.pr}",
        "--model",
        args.model,
        "--record-dir",
        str(records),
        "--label",
        label,
    ]
    process = subprocess.run(
        command, capture_output=True, text=True, cwd=RUNNER_DIR, check=False
    )
    (records / f"{label}.out").write_text(process.stdout + process.stderr)
    record_path = records / f"{label}.json"
    if not record_path.exists():
        print(f"{label}: NO RECORD (exit {process.returncode})")
        return 1
    record = json.loads(record_path.read_text())
    result = record["result"]
    usage = result.get("usage", {})
    cost = float(usage.get("costUsd") or 0.0)
    comment_path = records / f"{label}.comment.md"
    body = comment_path.read_text() if comment_path.exists() else None
    anon_id = ""
    scrubbed: list[str] = []
    if body is not None:
        anon_id = secrets.token_hex(3)
        text, scrubbed = anonymise(body)
        blind = Path(args.blind)
        (blind / "comments").mkdir(parents=True, exist_ok=True)
        (blind / "comments" / f"{anon_id}.md").write_text(text)
        with (blind / "index.csv").open("a", newline="") as handle:
            csv.writer(handle).writerow([anon_id, args.pr])
    mapping = Path(args.mapping)
    mapping.parent.mkdir(parents=True, exist_ok=True)
    new_file = not mapping.exists()
    with mapping.open("a", newline="") as handle:
        writer = csv.writer(handle)
        if new_file:
            writer.writerow(
                [
                    "id",
                    "model",
                    "pr",
                    "round",
                    "label",
                    "ok",
                    "errorCode",
                    "costUsd",
                    "durationMs",
                    "promptTokens",
                    "completionTokens",
                    "commentChars",
                    "status",
                ]
            )
        writer.writerow(
            [
                anon_id,
                args.model,
                args.pr,
                args.round,
                label,
                result.get("ok"),
                result.get("errorCode") or "",
                cost,
                result.get("durationMs"),
                usage.get("promptTokens"),
                usage.get("completionTokens"),
                len(body) if body is not None else "",
                # Set by hand afterwards for a run that is replaced by a repeat (see the report).
                "counted" if result.get("ok") and body is not None else "not_counted",
            ]
        )
    log_text = process.stdout + process.stderr
    watched = (
        "did not fit",
        "failed to",
        '"logtruncated":true',
        "provider comment limit",
    )
    flagged = [w for w in watched if w in log_text.lower()]
    print(
        f"{label} id={anon_id} ok={result.get('ok')} err={result.get('errorCode')} cost={cost:.4f} "
        f"dur_ms={result.get('durationMs')} tok={usage.get('promptTokens')}/"
        f"{usage.get('completionTokens')} chars={len(body) if body else None} "
        f"scrubbed={scrubbed} warn={flagged} precheck_deleted={len(check['botCommentsDeleted'])}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("list")
    plan = sub.add_parser("plan")
    plan.add_argument("--seed", type=int, required=True)
    plan.add_argument("--rounds", type=int, default=4)
    run = sub.add_parser("run")
    run.add_argument("--model", required=True, choices=MODELS)
    run.add_argument("--pr", type=int, required=True, choices=PULLS)
    run.add_argument("--round", type=int, required=True)
    run.add_argument(
        "--suffix", default="", help="label suffix of a repeat after a runner outage"
    )
    run.add_argument("--out", required=True)
    run.add_argument("--blind", required=True)
    run.add_argument("--mapping", required=True)
    args = parser.parse_args()
    if args.mode == "plan":
        print(json.dumps(schedule(args.seed, args.rounds)))
        return 0
    if args.mode == "list":
        token = mint_token()
        for pr in PULLS:
            comments = list_issue_comments(token, pr)
            print(
                f"#{pr}:",
                [(c["id"], c["user"]["login"], len(c["body"])) for c in comments],
                other_bot_traces(token, pr),
            )
        return 0
    return run_one(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as error:
        print(f"HTTP error {error.code} on {error.url.split('?')[0]}")
        sys.exit(1)
