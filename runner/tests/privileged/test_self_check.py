# SPDX-License-Identifier: Apache-2.0

"""The startup self-check against the real kernel, users and pinned engine (#202-T01, T09).

Root with the production capabilities in the job phase, i.e. after the production startup step:
static nft rules installed for the engine user, `NET_ADMIN` and `SETPCAP` gone. The engine binary is
the verified pinned OpenCode (copied to a root-owned directory, with a pin made from that very file;
the pin file of the repository against the file of the image is proven by the image smoke test), the
`rg` is the host's. Asserts what the check decides on a real system, never how the engine reviews.
"""

import hashlib
import json
import shutil
import sys
import tempfile
from collections.abc import Generator
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    PROXY_PORT,
    STRANGER_GID,
    STRANGER_UID,
    exec_directory,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine"))
from opencode_support import opencode_binary

from code_reviewer_runner.capabilities import ALL_ENGINES, ENGINE_DIFF
from code_reviewer_runner.dynamic_review.self_check import (
    DEFAULT_TOOLS,
    SelfCheckFailed,
    SelfCheckReason,
    ToolPaths,
    check_dynamic_runner,
    platform_key,
)
from code_reviewer_runner.dynamic_review.static_isolation import (
    DEFAULT_ENGINE_PORT,
    SlotPorts,
)
from code_reviewer_runner.job_loop import service
from code_reviewer_runner.job_loop.settings import settings_from_environment

PORTS = SlotPorts(PROXY_PORT, DEFAULT_ENGINE_PORT)
PINNED_VERSION = "1.19.0"


def pin_for(path: Path, pin: Path, version: str) -> None:
    content = path.read_bytes()
    pin.write_text(
        json.dumps(
            {
                "version": version,
                "platforms": {
                    platform_key(): {
                        "executableBytes": len(content),
                        "executableSha256": hashlib.sha256(content).hexdigest(),
                    }
                },
            }
        ),
        encoding="utf-8",
    )


@pytest.fixture(scope="module")
def tools() -> Generator[ToolPaths]:
    """The real engine and a real `rg` in a root-owned directory every user can enter."""
    directory = exec_directory("cr-self-check-")
    opencode, ripgrep = directory / "opencode", directory / "rg"
    shutil.copyfile(opencode_binary(), opencode)
    host_rg = shutil.which("rg")
    assert host_rg is not None, "rg is not installed"
    shutil.copyfile(host_rg, ripgrep)
    for executable in (opencode, ripgrep):
        executable.chmod(0o755)
    paths = ToolPaths(opencode, ripgrep, directory / "opencode-pin.json", directory / "rg-pin.json")
    pin_for(opencode, paths.opencode_pin, PINNED_VERSION)
    pin_for(ripgrep, paths.ripgrep_pin, "host")
    yield paths
    shutil.rmtree(directory, ignore_errors=True)


def check(installed: ToolPaths, **changes: Any) -> None:
    arguments: dict[str, Any] = {
        "user": (ENGINE_UID, ENGINE_GID),
        "ports": PORTS,
        "rules_installed": True,
        "tools": installed,
        # The tools sit in a directory of this suite, not under "/": the chain of directories above
        # them is judged up to its root. The chain from "/" is the image smoke test's.
        "chain_root": installed.opencode.parent,
        **changes,
    }
    check_dynamic_runner(**arguments)


def reason_of(installed: ToolPaths, **changes: Any) -> SelfCheckReason:
    with pytest.raises(SelfCheckFailed) as caught:
        check(installed, **changes)
    return caught.value.reason


# #202-T01
def test_the_real_system_passes_the_check_and_advertises_opencode(tools: ToolPaths) -> None:
    check(tools)
    settings = settings_from_environment(
        {
            "RUNNER_API_URL": "http://app.invalid:3000",
            "RUNNER_TOKEN": "dummy-runner-token-0123456789-abcdef-0123456789",
            "RUNNER_DIFF_JOB_USER": "10001:10001",
        }
    )

    advertised = service.advertise_engines(
        settings,
        True,
        check=partial(check_dynamic_runner, tools=tools, chain_root=tools.opencode.parent),
    )

    assert advertised.engines == ALL_ENGINES
    assert advertised.dynamic_command == (str(DEFAULT_TOOLS.opencode),)
    assert advertised.dynamic_ripgrep == str(DEFAULT_TOOLS.ripgrep)


# #202-T09: a user the network rules do not name is not confined: the probe says so.
def test_an_engine_user_without_the_network_rules_is_not_advertised(tools: ToolPaths) -> None:
    assert reason_of(tools, user=(STRANGER_UID, STRANGER_GID)) is (
        SelfCheckReason.NETWORK_PROBE_FAILED
    )


# #202-T09: a user that does not exist
def test_an_engine_user_that_does_not_exist_is_not_advertised(tools: ToolPaths) -> None:
    assert reason_of(tools, user=(10299, 10299)) is SelfCheckReason.ENGINE_USER_INVALID


# #202-T09: the group of the user must be its own
def test_an_engine_user_with_a_foreign_group_is_not_advertised(tools: ToolPaths) -> None:
    assert reason_of(tools, user=(ENGINE_UID, STRANGER_GID)) is SelfCheckReason.ENGINE_USER_INVALID


# #202-T09: the pinned executable is the one that runs
def test_a_binary_that_is_not_the_pinned_one_is_not_advertised(tools: ToolPaths) -> None:
    tampered = Path(tempfile.mkdtemp(dir=tools.opencode.parent)) / "opencode"
    tampered.parent.chmod(0o755)
    shutil.copyfile(tools.opencode, tampered)
    tampered.chmod(0o755)
    tampered.write_bytes(tampered.read_bytes() + b"\0")

    reason = reason_of(
        tools, tools=ToolPaths(tampered, tools.ripgrep, tools.opencode_pin, tools.ripgrep_pin)
    )

    assert reason is SelfCheckReason.ENGINE_BINARY_CHECKSUM_MISMATCH


# #202-T09: the engine itself says which release it is, as the engine user, offline.
def test_an_engine_that_reports_another_version_than_the_pin_is_not_advertised(
    tools: ToolPaths,
) -> None:
    other = Path(tempfile.mkdtemp(dir=tools.opencode.parent))
    other.chmod(0o755)
    pin = other / "opencode-pin.json"
    pin_for(tools.opencode, pin, "0.0.1")

    reason = reason_of(
        tools, tools=ToolPaths(tools.opencode, tools.ripgrep, pin, tools.ripgrep_pin)
    )

    assert reason is SelfCheckReason.ENGINE_VERSION_MISMATCH


# #202-T09: the check ran in the job phase, where the startup capabilities are gone; no probe or
# version of the engine was needed to see the runner is not Diff-only any more.
def test_diff_stays_advertised_whatever_the_check_says(tools: ToolPaths) -> None:
    settings = settings_from_environment(
        {
            "RUNNER_API_URL": "http://app.invalid:3000",
            "RUNNER_TOKEN": "dummy-runner-token-0123456789-abcdef-0123456789",
            "RUNNER_DIFF_JOB_USER": "10001:10001",
            "RUNNER_DYNAMIC_ENGINE_UID": "10299",
            "RUNNER_DYNAMIC_ENGINE_GID": "10299",
        }
    )

    advertised = service.advertise_engines(
        settings,
        True,
        check=partial(check_dynamic_runner, tools=tools, chain_root=tools.opencode.parent),
    )

    assert advertised.engines == (ENGINE_DIFF,)
