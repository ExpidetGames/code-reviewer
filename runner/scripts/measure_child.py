"""Runs a command, or several copies of it at once, and reports the peak memory and the duration of
each (CR-13). Standard library only, so it also runs inside the runner image.

    python measure_child.py [--count N] [--concurrency C] [--fake-llm] -- <command> [args...]

The job (JSON) is read from stdin and handed to every child on its stdin. With `--fake-llm` the
job's `llm.baseUrl` is pointed at a small server on 127.0.0.1 inside this process that answers
every chat completion with a canned review, so a run needs no model and costs nothing.

Prints exactly one line of JSON: per child the exit code (or the signal that ended it), the wall
time, the peak resident set size (`ru_maxrss` of the waited child, so only that process) and the
last line of its stdout parsed as JSON; plus, when the container has the counters, the peak memory
of the whole container (`memory.peak`, includes the page cache) and the number of OOM kills.
The exit code is 0 if every child exited with 0.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

CGROUP_ROOT = Path("/sys/fs/cgroup")
RESULT_TEXT_CHARS = 2000
STDERR_TAIL_CHARS = 500

CANNED_REVIEW = """```yaml
review:
  estimated_effort_to_review_[1-5]: 3
  relevant_tests: |
    No
  key_issues_to_review:
    - relevant_file: |
        src/example.ts
      issue_header: |
        Possible Bug
      issue_content: |
        A canned finding from the fake model.
      start_line: 1
      end_line: 2
  security_concerns: |
    No
```
"""


def peak_rss_mb(raw: int, platform: str) -> float:
    """`ru_maxrss` is in kilobytes on Linux and in bytes on macOS."""
    return raw / (1024 * 1024) if platform == "darwin" else raw / 1024


class _FakeLlmHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        body = json.dumps(
            {
                "id": "fake-completion",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "fake/model",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": CANNED_REVIEW},
                    }
                ],
                "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100},
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def start_fake_llm() -> tuple[ThreadingHTTPServer, int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeLlmHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, int(server.server_address[1])


def read_cgroup(root: Path = CGROUP_ROOT) -> dict[str, float | int] | None:
    """Peak memory and OOM kills of the container, or None outside a cgroup v2 container."""
    try:
        peak = int((root / "memory.peak").read_text().strip())
    except (OSError, ValueError):
        return None
    kills = 0
    try:
        for line in (root / "memory.events").read_text().splitlines():
            name, _, value = line.partition(" ")
            if name == "oom_kill":
                kills = int(value)
    except (OSError, ValueError):
        pass
    return {"peakMb": peak / (1024 * 1024), "oomKills": kills}


def _parse_result(text: str) -> Any:
    for line in reversed(text.strip().splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            return None
    return None


def run_child(index: int, command: list[str], job: str) -> dict[str, Any]:
    with tempfile.TemporaryFile("w+") as out, tempfile.TemporaryFile("w+") as err:
        started = time.monotonic()
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=out, stderr=err, text=True
        )
        assert process.stdin is not None
        try:
            process.stdin.write(job)
            process.stdin.close()
        except BrokenPipeError:
            pass
        _, status, usage = os.wait4(process.pid, 0)
        wall_ms = int((time.monotonic() - started) * 1000)
        out.seek(0)
        err.seek(0)
        text = out.read()
        stderr_text = err.read()
    signaled = os.WIFSIGNALED(status)
    return {
        "index": index,
        "exitCode": None if signaled else os.waitstatus_to_exitcode(status),
        "signal": signal.Signals(os.WTERMSIG(status)).name if signaled else None,
        "wallMs": wall_ms,
        "peakRssMb": round(peak_rss_mb(usage.ru_maxrss, sys.platform), 1),
        "result": _parse_result(text),
        "resultText": text[-RESULT_TEXT_CHARS:],
        "stderrTail": stderr_text[-STDERR_TAIL_CHARS:],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--count", type=int, default=1, help="how many children in total")
    parser.add_argument("--concurrency", type=int, help="how many at the same time (default: all)")
    parser.add_argument("--fake-llm", action="store_true", help="serve a canned model answer")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")

    job = sys.stdin.read()
    server = None
    if args.fake_llm:
        server, port = start_fake_llm()
        loaded = json.loads(job)
        loaded["llm"]["baseUrl"] = f"http://127.0.0.1:{port}/v1"
        job = json.dumps(loaded)

    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.concurrency or args.count) as pool:
        futures = [pool.submit(run_child, index, command, job) for index in range(args.count)]
        children = [future.result() for future in futures]
    if server is not None:
        server.shutdown()

    report = {
        "platform": sys.platform,
        "wallMs": int((time.monotonic() - started) * 1000),
        "children": children,
        "cgroup": read_cgroup(),
    }
    sys.stdout.write(json.dumps(report) + "\n")
    return 0 if all(child["exitCode"] == 0 for child in children) else 1


if __name__ == "__main__":
    sys.exit(main())
