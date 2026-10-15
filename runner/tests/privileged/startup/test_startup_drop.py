# SPDX-License-Identifier: Apache-2.0

"""The Dynamic runner's startup step against the real kernel (#244).

`startup_process.py` runs the production `prepare_dynamic_runtime` as root with the capabilities the
container is created with. The tests judge what the kernel says about the result: the static rules
for the single slot are in place, and neither that process, nor its threads, nor anything it starts
(a job process, the engine user's process) can hold `NET_ADMIN` or `SETPCAP` again.
"""

import json
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from privileged_support import (
    ENGINE_PORT,
    ENGINE_UID,
    JOB_CAPABILITIES,
    PROXY_PORT,
    STARTUP_CAPABILITIES,
    TRUSTED_PATH,
    ipv6_settings_restored,
)

from code_reviewer_runner.dynamic_review.netguard import EgressMode, table_family, table_name

STARTUP = Path(__file__).resolve().parents[1] / "startup_process.py"
JOB_SET = sum(1 << number for number in JOB_CAPABILITIES.values())
STARTUP_SET = sum(1 << number for number in STARTUP_CAPABILITIES.values())


def nft(*arguments: str) -> subprocess.CompletedProcess[str]:
    path = shutil.which("nft", path="/usr/sbin:/sbin:" + TRUSTED_PATH)
    assert path is not None, "nft is not installed"
    return subprocess.run(
        [path, *arguments], capture_output=True, text=True, timeout=30, check=False
    )


def delete_both_tables() -> None:
    for mode in EgressMode:
        nft("delete", "table", table_family(mode), table_name(ENGINE_UID))


@pytest.fixture(autouse=True)
def no_rules_left() -> Iterator[None]:
    # The fallback step switches IPv6 off for the whole namespace: put it back after each test.
    with ipv6_settings_restored():
        delete_both_tables()
        yield
        delete_both_tables()


def start_the_runner(*flags: str) -> dict[str, Any]:
    done = subprocess.run(
        [sys.executable, str(STARTUP), *flags],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


# #244-T07
def test_after_startup_neither_net_admin_nor_setpcap_is_left_for_the_loop_or_what_it_starts() -> (
    None
):
    report = start_the_runner()

    assert report["installed"] is True
    assert report["mode"] == "full"  # the CI kernel is complete, and the step finds that out
    # The loop itself, a thread created later, a job process (root) and the engine user's process:
    # the bounding set (what a process can ever get back) holds neither capability in any of them.
    for who in ("loop", "thread", "job_process", "engine"):
        sets = report[who]
        for name in ("CapBnd", "CapEff", "CapPrm", "CapInh", "CapAmb"):
            assert sets[name] & STARTUP_SET == 0, (who, name)
        assert sets["CapBnd"] == JOB_SET, who
    # The supervisor keeps exactly what its job needs, no more.
    for who in ("loop", "thread", "job_process"):
        assert report[who]["CapEff"] == JOB_SET, who
    # The engine user has no capability at all (the uid change cleared them).
    assert report["engine"]["CapEff"] == 0
    assert report["engine"]["CapPrm"] == 0
    assert report["capabilities_check"] == "ok"


# #244-T08
def test_after_startup_nft_fails_for_the_supervisor_and_for_its_job_processes() -> None:
    report = start_the_runner()

    # Not reading, not adding, not deleting this user's table and not flushing everything.
    assert all(code != 0 for code in report["nft"].values()), report["nft"]
    assert report["job_process_nft"] != 0
    # ... and the rules are there all the same: a process that still holds NET_ADMIN (this test)
    # reads them back, for the slot's fixed ports and nothing else.
    listing = nft("list", "table", "inet", table_name(ENGINE_UID))
    assert listing.returncode == 0, listing.stderr
    accepts = [
        line.strip()
        for line in listing.stdout.splitlines()
        if "skuid" in line and line.rstrip().endswith("accept")
    ]
    assert len(accepts) == 3
    assert any(f"tcp sport {ENGINE_PORT}" in line and "established" in line for line in accepts)
    assert any(f"tcp dport {PROXY_PORT}" in line for line in accepts)
    assert any(f"tcp dport {ENGINE_PORT}" in line for line in accepts)
    assert listing.stdout.count("reject") == 1


# #244-T10
def test_after_startup_the_probe_run_as_the_engine_user_passes_against_the_static_rules() -> None:
    report = start_the_runner()

    assert report["probe"] == "ok", report["probe"]


# #244-T05
def test_starting_the_runner_again_replaces_the_rules_and_does_not_stack_them() -> None:
    start_the_runner()
    start_the_runner()  # a restarted container, or the same netns reused

    listing = nft("list", "table", "inet", table_name(ENGINE_UID))
    assert listing.returncode == 0, listing.stderr
    assert listing.stdout.count("meta skuid") == 4


# #244-T05
def test_a_host_without_nft_still_loses_net_admin_and_every_dynamic_job_fails_closed() -> None:
    report = start_the_runner("--no-nft")

    assert report["installed"] is False
    for who in ("loop", "job_process"):
        for name in ("CapBnd", "CapEff", "CapPrm"):
            assert report[who][name] & STARTUP_SET == 0, (who, name)
    # No rules, so the probe run as the engine user sees an open network and refuses to go on.
    assert "other than its model proxy" in report["probe"]
    assert nft("list", "table", "inet", table_name(ENGINE_UID)).returncode != 0


# -- the fallback mode (#345) -------------------------------------------------


# #345-T05 #345-T18
def test_the_startup_step_in_fallback_mode_installs_the_ip_rules_and_switches_ipv6_off() -> None:
    report = start_the_runner("--fallback")

    assert report["installed"] is True
    assert report["mode"] == "fallback"
    assert report["ipv6_problem"] is None, report["ipv6_problem"]
    assert report["ipv6_proof"] == "ok", report["ipv6_proof"]
    assert report["probe"] == "ok", report["probe"]
    listing = nft("list", "table", "ip", table_name(ENGINE_UID))
    assert listing.returncode == 0, listing.stderr
    accepts = [
        line for line in listing.stdout.splitlines() if "skuid" in line and line.endswith("accept")
    ]
    assert len(accepts) == 3
    assert listing.stdout.count("drop") == 1
    assert "reject" not in listing.stdout
    # No table of the full mode was made on the side.
    assert nft("list", "table", "inet", table_name(ENGINE_UID)).returncode != 0


# #345-T05 #345-T18
def test_in_fallback_mode_too_the_startup_capabilities_are_gone_and_nft_is_out_of_reach() -> None:
    report = start_the_runner("--fallback")

    for who in ("loop", "thread", "job_process", "engine"):
        for name in ("CapBnd", "CapEff", "CapPrm", "CapInh", "CapAmb"):
            assert report[who][name] & STARTUP_SET == 0, (who, name)
        assert report[who]["CapBnd"] == JOB_SET, who
    assert all(code != 0 for code in report["nft"].values()), report["nft"]
    assert report["job_process_nft"] != 0
    assert report["capabilities_check"] == "ok"


# #345-T05
def test_starting_in_fallback_mode_again_replaces_the_rules_and_does_not_stack_them() -> None:
    start_the_runner("--fallback")
    start_the_runner("--fallback")

    listing = nft("list", "table", "ip", table_name(ENGINE_UID))
    assert listing.returncode == 0, listing.stderr
    assert listing.stdout.count("meta skuid") == 4


# #345-T05: a runner that cannot install anything in either mode still ends NET_ADMIN.
def test_fallback_mode_without_nft_still_loses_net_admin_and_every_dynamic_job_fails_closed() -> (
    None
):
    report = start_the_runner("--fallback", "--no-nft")

    assert report["installed"] is False
    for who in ("loop", "job_process"):
        for name in ("CapBnd", "CapEff", "CapPrm"):
            assert report[who][name] & STARTUP_SET == 0, (who, name)
    assert "other than its model proxy" in report["probe"]
