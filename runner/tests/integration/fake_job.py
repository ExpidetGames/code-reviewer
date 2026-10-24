# SPDX-License-Identifier: LicenseRef-Proprietary

"""Test helper, not a test: a stand-in for `code-reviewer-run-job` that the job loop starts as a
real process. It reads the job from stdin like the real one and does what the scenario says.

    python fake_job.py <scenario> <directory>

Every scenario first writes what it observed to `<directory>/<pid>.json`: its environment, its
argument list, the command line `ps` shows for it and the job from stdin.

    ok          print a successful result line
    fail        write to stderr and exit with 3, no result line
    hang        wait for 60 seconds
    stubborn    ignore SIGTERM, start a helper process that also waits, then wait; the pids of
                both are in the report
    leak        write both credentials of the job to stdout and stderr, and into a failed result
    flood       write 100 MB to stdout and 100 MB to stderr, then a successful result line
    wait        wait until `<directory>/go` exists (at most 30 seconds), then print a result line
    summary     ask the host over the lease channel (as a Dynamic job does right before it writes
                its summary) and write `<directory>/summary` only if the answer is "held"; the
                result line says which answer it got
    superseded  wait for SIGUSR1 (the host unblocks it as the real process does once it has its
                handler), then print the result of a superseded run (with the cost it measured)
                and exit 1
    deaf        never read SIGUSR1 (it stays blocked) and ignore SIGTERM, start a helper that also
                waits; the pids of both are in the report: a process that does not drain
    kill        end by SIGKILL, with no result line and nothing cleaned up (an OOM kill)
"""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

scenario = sys.argv[1]
directory = Path(sys.argv[2])
raw = sys.stdin.read()
job = json.loads(raw)

command_line = subprocess.run(
    ["ps", "-o", "command=", "-p", str(os.getpid())], capture_output=True, text=True, check=False
).stdout.strip()
report = {
    "pid": os.getpid(),
    "environ": dict(os.environ),
    "argv": sys.argv,
    "command_line": command_line,
    "stdin": raw,
    "cwd": os.getcwd(),
    "cwd_files": sorted(os.listdir(".")),
}
(directory / f"{os.getpid()}.json").write_text(json.dumps(report))


def result(**overrides: object) -> str:
    value: dict[str, object] = {
        "ok": True,
        "durationMs": 5,
        "commentUrl": "https://github.com/octo/repo/pull/7#c1",
        "errorCode": None,
        "logTail": "fake review published",
        "logTruncated": False,
        "usage": None,
    }
    value.update(overrides)
    return json.dumps(value)


if scenario == "ok":
    print(result())
elif scenario == "fail":
    for number in range(2000):
        sys.stderr.write(f"stderr line {number:05d} {'e' * 80}\n")
    sys.exit(3)
elif scenario == "hang":
    time.sleep(60)
elif scenario == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    helper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    (directory / "helper.pid").write_text(str(helper.pid))
    time.sleep(60)
elif scenario == "leak":
    token = job["git"]["token"]
    key = job["llm"]["apiKey"]
    print(f"stdout token {token} key {key}")
    sys.stderr.write(f"stderr token {token} key {key}\n")
    print(
        result(
            ok=False,
            errorCode="command_failed",
            commentUrl=None,
            logTail=f"tail token {token} key {key}",
        )
    )
    sys.exit(1)
elif scenario == "flood":
    block = ("x" * 1023 + "\n").encode() * 1024  # 1 MB
    for _ in range(100):
        sys.stdout.buffer.write(block)
        sys.stderr.buffer.write(block)
    sys.stdout.buffer.flush()
    sys.stderr.buffer.flush()
    print(result())
elif scenario == "wait":
    for _ in range(300):
        if (directory / "go").exists():
            break
        time.sleep(0.1)
    print(result())
elif scenario == "summary":
    from code_reviewer_runner.lease_check import lease_check_from_environment

    check = lease_check_from_environment(os.environ)
    answer = check().value if check is not None else "no channel"
    if answer == "held":
        (directory / "summary").write_text("the summary")
    print(result(ok=answer == "held", errorCode=None if answer == "held" else "lease_lost"))
elif scenario == "superseded":
    told: list[int] = []

    def on_signal(signum: int, frame: object) -> None:
        told.append(1)

    signal.signal(signal.SIGUSR1, on_signal)
    signal.pthread_sigmask(signal.SIG_UNBLOCK, [signal.SIGUSR1])
    for _ in range(300):
        if told:
            break
        time.sleep(0.1)
    print(
        result(
            ok=False,
            commentUrl=None,
            errorCode="superseded",
            logTail="superseded: a newer push replaced this run",
            usage={
                "model": "m",
                "promptTokens": 600,
                "completionTokens": 150,
                "totalTokens": 750,
                "aiCalls": 1,
                "fallbackUsed": False,
                "costUsd": 0.0042,
            },
        )
    )
    sys.exit(1)
elif scenario == "deaf":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    helper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    (directory / "helper.pid").write_text(str(helper.pid))
    time.sleep(60)
elif scenario == "kill":
    os.kill(os.getpid(), signal.SIGKILL)
else:
    sys.exit(99)
