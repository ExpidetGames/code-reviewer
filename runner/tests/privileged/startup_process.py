# SPDX-License-Identifier: Apache-2.0

"""The Dynamic runner's startup step, run for real in a process of its own (#244).

The startup phase of the privileged suite starts this as root with the capabilities the container
is created with. It builds the loop's settings from an environment exactly as the entry point does,
runs `prepare_dynamic_runtime` (the static nft rules, then the end of `NET_ADMIN` and `SETPCAP`)
and then reports what a loop in that state, its threads, a job process and the engine user can
still do. A test can then judge the report without trusting the process under test: the effect on
the kernel is read back from `/proc` and from `nft` itself.

    startup_process.py [--no-nft]

`--no-nft` makes the nft tool unavailable to the startup step only, which is how a host without
`nf_tables` looks to it.
"""

import json
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    PROXY_PORT,
    RUNNER_ENVIRONMENT,
    TRUSTED_PATH,
    python3,
    slot_proxy,
)

from code_reviewer_runner.dynamic_review import netguard
from code_reviewer_runner.dynamic_review.netguard import (
    IsolationError,
    table_name,
    verify_confinement,
)
from code_reviewer_runner.dynamic_review.static_isolation import (
    capability_sets,
    require_startup_capabilities_gone,
)
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.settings import settings_from_environment

CAPABILITIES_OF_A_PROCESS = (
    "print(''.join(line for line in open('/proc/self/status') if line.startswith('Cap')))"
)


def capabilities_of_a_child(user: tuple[int, int] | None) -> dict[str, int]:
    """The capability sets of a new process started the way the loop starts its children."""
    options: dict[str, Any] = {}
    if user is not None:
        options = {"user": user[0], "group": user[1], "extra_groups": []}
    done = subprocess.run(
        [python3(), "-I", "-c", CAPABILITIES_OF_A_PROCESS],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
        env={"PATH": TRUSTED_PATH},
        **options,
    )
    return capability_sets(done.stdout)


def capabilities_of_a_thread() -> dict[str, int]:
    """A thread started after the step: it copies the capabilities of the thread that started it."""
    found: dict[str, int] = {}

    def read() -> None:
        found.update(capability_sets(Path("/proc/thread-self/status").read_text()))

    thread = threading.Thread(target=read)
    thread.start()
    thread.join()
    return found


def nft_commands(nft: str) -> dict[str, int]:
    """Whether the supervisor can still read or change the rules: every command must fail."""
    commands = {
        "list": ["list", "tables"],
        "add": ["add", "table", "inet", "code_reviewer_probe"],
        "delete": ["delete", "table", "inet", table_name(ENGINE_UID)],
        "flush": ["flush", "ruleset"],
    }
    return {
        name: subprocess.run(
            [nft, *arguments], capture_output=True, timeout=30, check=False
        ).returncode
        for name, arguments in commands.items()
    }


def judged(check: Any) -> str:
    try:
        check()
    except IsolationError as error:
        return str(error)
    return "ok"


def main(argv: list[str]) -> int:
    import shutil

    nft = shutil.which("nft", path="/usr/sbin:/sbin:" + TRUSTED_PATH)
    assert nft is not None, "nft is not installed"
    settings = settings_from_environment(RUNNER_ENVIRONMENT)
    searched = netguard._NFT_PATH  # pyright: ignore[reportPrivateUsage]
    if "--no-nft" in argv:
        # Where the startup step looks for nft: nowhere. The tests' own nft calls are unaffected.
        netguard._NFT_PATH = "/nonexistent"  # pyright: ignore[reportPrivateUsage]
    try:
        installed = service.prepare_dynamic_runtime(settings)
    finally:
        netguard._NFT_PATH = searched  # pyright: ignore[reportPrivateUsage]
    with slot_proxy():
        report = {
            "installed": installed,
            "loop": capability_sets(Path("/proc/self/status").read_text()),
            "thread": capabilities_of_a_thread(),
            "job_process": capabilities_of_a_child(None),
            "engine": capabilities_of_a_child((ENGINE_UID, ENGINE_GID)),
            "nft": nft_commands(nft),
            "job_process_nft": json.loads(
                subprocess.run(
                    [
                        python3(),
                        "-I",
                        "-c",
                        "import json, subprocess, sys; "
                        "print(json.dumps(subprocess.call([sys.argv[1], 'list', 'tables'], "
                        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)))",
                        nft,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=True,
                ).stdout
            ),
            "capabilities_check": judged(require_startup_capabilities_gone),
            "probe": judged(lambda: verify_confinement(ENGINE_UID, ENGINE_GID, PROXY_PORT)),
        }
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
