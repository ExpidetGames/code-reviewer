# SPDX-License-Identifier: Apache-2.0

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
maximum of the runner's own `durationMs`, the peak memory and the CPU time; children that were
killed, for example by the out-of-memory killer, are counted but left out of those figures). The
exit code is 1 if any child failed or was killed.

Every run posts or EDITS the real review comment of the sandbox pull request. Real runs also cost a
few cents. With `--fake-llm` the model is a local canned server: it costs nothing and the real LLM
key is not even put into the job, but the canned finding overwrites the real review comment (GitHub
is still contacted, and parallel runs write the same comment). Nothing runs without `--yes`. The
numbers are bounded (at most 10 repeats, 10 processes) because each real run costs money.
"""

import argparse
import json
import os
import statistics
import subprocess
import sys
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, cast

sys.path.insert(0, str(Path(__file__).parent))
import manual_review  # the sibling script, imported for the job and token helpers

REQUIRED_ENV = manual_review.REQUIRED_ENV
mint_installation_token = manual_review.mint_installation_token
SCRIPTS_DIR = Path(__file__).parent
SIZES = {"small": 1, "medium": 2, "large": 3}
MAX_REPEAT = 10
MAX_COUNT = 10
FAKE_LLM_KEY = "fake-llm-key-not-a-real-key"
DEFAULT_TIMEOUT_MINUTES = 30
LEAK_FRAGMENT = 12


def pr_url_for(size: str) -> str:
    return f"https://github.com/{manual_review.ALLOWED_REPOSITORY}/pull/{SIZES[size]}"


def wrapper_command(
    *,
    count: int,
    concurrency: int | None,
    fake_llm: bool,
    docker: str | None,
    memory: str | None = None,
    container: str | None = None,
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
    name = ["--name", container] if container else []
    return [
        "docker",
        "run",
        "--rm",
        "-i",
        *name,
        *limits,
        # --mount fails clearly on a missing path (and copes with a colon in it, unlike -v)
        "--mount",
        f"type=bind,source={SCRIPTS_DIR},target=/measure,readonly",
        "--entrypoint",
        "python",
        docker,
        "/measure/measure_child.py",
        *options,
        "--",
        "code-reviewer-run-job",
    ]


def run_wrapper(
    command: list[str],
    job: dict[str, Any],
    container: str | None = None,
    timeout_minutes: float = DEFAULT_TIMEOUT_MINUTES,
) -> tuple[int, str, str]:
    """Run the wrapper. On a timeout the container is killed too: `docker run --rm` ends only its
    client when the process is killed, and the runner processes inside could go on spending."""
    environment = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/tmp")}
    try:
        process = subprocess.run(
            command,
            input=json.dumps(job),
            capture_output=True,
            text=True,
            env=environment,
            timeout=timeout_minutes * 60,
            check=False,
        )
    except subprocess.TimeoutExpired:
        if container is not None:
            subprocess.run(["docker", "kill", container], capture_output=True, check=False)
        raise
    return process.returncode, process.stdout, process.stderr


def leaks(secrets: Sequence[str], *streams: str) -> bool:
    """True if a secret, or its first or last 12 characters, is in a stream. A secret cut by a
    truncation at either end is still found by its remaining fragment."""
    fragments = [
        part
        for secret in secrets
        for part in (secret, secret[:LEAK_FRAGMENT], secret[-LEAK_FRAGMENT:])
        if len(secret) >= LEAK_FRAGMENT
    ]
    return any(fragment in stream for fragment in fragments for stream in streams)


def _stats(values: Sequence[float]) -> dict[str, float] | None:
    if not values:
        return None
    return {
        "min": round(min(values), 1),
        "median": round(statistics.median(values), 1),
        "max": round(max(values), 1),
    }


def _result_of(child: dict[str, Any]) -> dict[str, Any] | None:
    result = child.get("result")
    return cast(dict[str, Any], result) if isinstance(result, dict) else None


def summarize(reports: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Minimum, median and maximum over all children. Killed children (no exit code) are counted
    in `killed` and left out of the figures; a child without a parseable result counts as failed."""
    children: list[dict[str, Any]] = [child for report in reports for child in report["children"]]
    killed = [child for child in children if child.get("exitCode") is None]
    finished = [child for child in children if child.get("exitCode") is not None]
    failed = [
        child
        for child in finished
        if child["exitCode"] != 0 or (_result_of(child) or {}).get("ok") is not True
    ]
    durations: list[float] = []
    for child in finished:
        result = _result_of(child)
        milliseconds = result.get("durationMs") if result else None
        # the runner's own duration; the wrapper's wall time (process start and imports included)
        # only if there is no result
        durations.append(
            (milliseconds if isinstance(milliseconds, int | float) else child["wallMs"]) / 1000
        )
    summary: dict[str, Any] = {
        "runs": len(children),
        "killed": len(killed),
        "failures": len(killed) + len(failed),
        "durationSeconds": _stats(durations),
        "peakRssMb": _stats([child["peakRssMb"] for child in finished]),
    }
    cpu = [child["cpuSeconds"] for child in finished if "cpuSeconds" in child]
    if cpu:
        summary["cpuSeconds"] = _stats(cpu)
    costs: list[float] = []
    for child in children:
        result = _result_of(child) or {}
        usage: Any = result.get("usage")
        if isinstance(usage, dict) and cast(dict[str, Any], usage).get("costUsd") is not None:
            costs.append(float(cast(dict[str, Any], usage)["costUsd"]))
    if costs:
        summary["costUsd"] = round(sum(costs), 4)
    return summary


def _bounded(maximum: int) -> Callable[[str], int]:
    def parse(text: str) -> int:
        value = int(text)
        if not 1 <= value <= maximum:
            raise argparse.ArgumentTypeError(f"must be between 1 and {maximum}")
        return value

    return parse


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--size", choices=sorted(SIZES), required=True)
    parser.add_argument("--repeat", type=_bounded(MAX_REPEAT), default=1, help="batches to run")
    parser.add_argument("--count", type=_bounded(MAX_COUNT), default=1, help="processes per batch")
    parser.add_argument(
        "--concurrency", type=_bounded(MAX_COUNT), help="processes at the same time (default: all)"
    )
    parser.add_argument("--fake-llm", action="store_true")
    parser.add_argument("--docker", metavar="IMAGE", help="run in this runner image")
    parser.add_argument("--memory", help="memory limit of the container, for example 2g")
    parser.add_argument("--model", default=manual_review.DEFAULT_MODEL)
    parser.add_argument("--timeout-minutes", type=float, default=DEFAULT_TIMEOUT_MINUTES)
    parser.add_argument("--yes", action="store_true", help="really run")
    args = parser.parse_args(argv)

    pr_url = pr_url_for(args.size)
    if not args.yes:
        print(f"Would measure {args.repeat} x {args.count} runner process(es) on {pr_url}.")
        print("Every run posts or edits the real review comment of that sandbox pull request.")
        if args.fake_llm:
            print(
                "With --fake-llm it costs nothing, but the canned finding overwrites that comment."
            )
        else:
            print("Real runs also cost a few cents each.")
        print("Add --yes to run.")
        return 2
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"missing environment variables: {', '.join(missing)}")

    token = mint_installation_token(
        os.environ["GITHUB_APP_ID"],
        os.environ["GITHUB_APP_INSTALLATION_ID"],
        Path(os.environ["GITHUB_APP_PRIVATE_KEY_PATH"]),
    )
    real_key = os.environ["OPENROUTER_API_KEY"]
    # In fake mode the real key never enters the job: that run must not be able to spend money.
    api_key = FAKE_LLM_KEY if args.fake_llm else real_key
    job = manual_review.build_job(
        pr_url,
        "review",
        token,
        os.environ["GITHUB_APP_SLUG"],
        api_key,
        args.model,
        manual_review.DEFAULT_MAX_TOKENS,
    )
    container = f"cr-measure-{uuid.uuid4().hex[:12]}" if args.docker else None
    command = wrapper_command(
        count=args.count,
        concurrency=args.concurrency,
        fake_llm=args.fake_llm,
        docker=args.docker,
        memory=args.memory,
        container=container,
    )
    mode = {"docker": args.docker, "memory": args.memory, "fakeLlm": args.fake_llm}
    reports: list[dict[str, Any]] = []
    for repeat in range(args.repeat):
        code, stdout, stderr = run_wrapper(command, job, container, args.timeout_minutes)
        if leaks([token, real_key], stdout, stderr):
            print("SECRET SCAN FAILED: a secret was found in the output of the wrapper")
            return 2
        try:
            report: dict[str, Any] = json.loads(stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            print(f"no report from the wrapper (exit code {code}); stderr:\n{stderr[-2000:]}")
            return 1
        reports.append(report)
        line = {"prUrl": pr_url, "size": args.size, "repeat": repeat, "mode": mode, **report}
        print(json.dumps(line))
    summary = summarize(reports)
    print(json.dumps({"summary": summary, "size": args.size, "mode": mode}))
    return 1 if summary["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
