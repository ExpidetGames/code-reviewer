"""Measures the memory and duration of runner processes against the sandbox pull requests (CR-13).

Builds the job like `manual_review.py` (installation token limited to the sandbox repository, LLM
key from the environment), hands it on stdin to `measure_child.py`, which starts one or several
`code-reviewer-run-job` processes and reports each one's peak memory and duration. The wrapper runs
on this machine, or in the runner image with a memory limit (`--docker IMAGE --memory 2g`), which is
what the production container looks like.

    uv run python scripts/measure_runs.py --size small|medium|large [--repeat 3] [--count N]
        [--concurrency C] [--fake-llm] [--docker IMAGE --memory 2g] --yes

Needs the same environment variables as `manual_review.py` (load them with `set -a; . <file>; set
+a`). Prints one JSON line per repeat and, at the end, one line with a summary (minimum, median and
maximum). Real runs (without `--fake-llm`) post or edit a real comment and cost a few cents; with
`--fake-llm` the model is a local canned server and the run is free (GitHub is still contacted).
Nothing runs without `--yes`.
"""

import argparse
import json
import os
import statistics
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import manual_review  # the sibling script, imported for the job and token helpers

REQUIRED_ENV = manual_review.REQUIRED_ENV
mint_installation_token = manual_review.mint_installation_token
SCRIPTS_DIR = Path(__file__).parent
SIZES = {"small": 1, "medium": 2, "large": 3}


def pr_url_for(size: str) -> str:
    return f"https://github.com/{manual_review.ALLOWED_REPOSITORY}/pull/{SIZES[size]}"


def wrapper_command(
    *,
    count: int,
    concurrency: int | None,
    fake_llm: bool,
    docker: str | None,
    memory: str | None = None,
) -> list[str]:
    options = ["--count", str(count)]
    if concurrency is not None:
        options += ["--concurrency", str(concurrency)]
    if fake_llm:
        options.append("--fake-llm")
    if docker is None:
        entry = str(Path(sys.executable).parent / "code-reviewer-run-job")
        return [sys.executable, str(SCRIPTS_DIR / "measure_child.py"), *options, "--", entry]
    limits = ["--memory", memory, "--memory-swap", memory] if memory else []
    return [
        "docker",
        "run",
        "--rm",
        "-i",
        *limits,
        "-v",
        f"{SCRIPTS_DIR}:/measure:ro",
        "--entrypoint",
        "python",
        docker,
        "/measure/measure_child.py",
        *options,
        "--",
        "code-reviewer-run-job",
    ]


def run_wrapper(command: list[str], job: dict[str, Any]) -> tuple[int, str, str]:
    environment = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}
    process = subprocess.run(
        command,
        input=json.dumps(job),
        capture_output=True,
        text=True,
        env=environment,
        timeout=60 * 60,
        check=False,
    )
    return process.returncode, process.stdout, process.stderr


def _stats(values: Sequence[float]) -> dict[str, float]:
    return {
        "min": round(min(values), 1),
        "median": round(statistics.median(values), 1),
        "max": round(max(values), 1),
    }


def summarize(reports: Sequence[dict[str, Any]]) -> dict[str, Any]:
    children = [child for report in reports for child in report["children"]]
    failures = [
        child
        for child in children
        if child.get("exitCode") != 0 or not (child.get("result") or {}).get("ok", True)
    ]
    summary: dict[str, Any] = {
        "runs": len(children),
        "failures": len(failures),
        "peakRssMb": _stats([child["peakRssMb"] for child in children]),
        "wallSeconds": _stats([child["wallMs"] / 1000 for child in children]),
    }
    costs = [
        child["result"]["usage"]["costUsd"]
        for child in children
        if isinstance(child.get("result"), dict)
        and isinstance(child["result"].get("usage"), dict)
        and child["result"]["usage"].get("costUsd") is not None
    ]
    if costs:
        summary["costUsd"] = round(sum(costs), 4)
    return summary


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--size", choices=sorted(SIZES), required=True)
    parser.add_argument("--repeat", type=int, default=1, help="how many times to run the batch")
    parser.add_argument("--count", type=int, default=1, help="processes per batch")
    parser.add_argument("--concurrency", type=int, help="processes at the same time (default: all)")
    parser.add_argument("--fake-llm", action="store_true")
    parser.add_argument("--docker", metavar="IMAGE", help="run in this runner image")
    parser.add_argument("--memory", help="memory limit of the container, for example 2g")
    parser.add_argument("--model", default=manual_review.DEFAULT_MODEL)
    parser.add_argument("--yes", action="store_true", help="really run")
    args = parser.parse_args(argv)

    pr_url = pr_url_for(args.size)
    if not args.yes:
        print(f"Would measure {args.repeat} x {args.count} runner process(es) on {pr_url}.")
        print("Add --yes to run (real runs post a comment and cost money).")
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
    job = manual_review.build_job(
        pr_url,
        "review",
        token,
        os.environ["GITHUB_APP_SLUG"],
        api_key,
        args.model,
        manual_review.DEFAULT_MAX_TOKENS,
    )
    command = wrapper_command(
        count=args.count,
        concurrency=args.concurrency,
        fake_llm=args.fake_llm,
        docker=args.docker,
        memory=args.memory,
    )
    mode = {"docker": args.docker, "memory": args.memory, "fakeLlm": args.fake_llm}
    reports: list[dict[str, Any]] = []
    for repeat in range(args.repeat):
        code, stdout, stderr = run_wrapper(command, job)
        if any(secret in stream for secret in (token, api_key) for stream in (stdout, stderr)):
            print("SECRET SCAN FAILED: a secret was found in the output of the wrapper")
            return 2
        try:
            report: dict[str, Any] = json.loads(stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            print(f"no report from the wrapper (exit code {code}); stderr:\n{stderr[-2000:]}")
            return 1
        reports.append(report)
        print(
            json.dumps(
                {"prUrl": pr_url, "size": args.size, "repeat": repeat, "mode": mode, **report}
            )
        )
    print(json.dumps({"summary": summarize(reports), "size": args.size, "mode": mode}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
