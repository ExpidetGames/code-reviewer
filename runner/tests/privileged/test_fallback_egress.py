# SPDX-License-Identifier: Apache-2.0

"""The fallback egress ruleset in the job phase, behind the production startup step (#345-T18).

Only the fallback pass of the job phase runs these (`CR_PRIVILEGED_EGRESS_MODE=fallback`, see
`privileged_phases.sh`): the startup step was told, through its `detect` seam, that the kernel has
no `inet` table or no `reject`, installed the `ip`-family rules and switched IPv6 off. Everything
here is judged after the supervisor dropped `NET_ADMIN` and `SETPCAP`. The rest of
the job phase (the rules, the probe, the launch, the self-check) runs in this pass as well and
accepts a dropped connection where the full mode demands an immediate refusal.
"""

import errno
import shutil
import subprocess
from pathlib import Path

import pytest
from privileged_support import (
    EGRESS_MODE,
    ENGINE_GID,
    ENGINE_UID,
    TRUSTED_PATH,
    run_as,
    slot_proxy,
)

from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.ipv6_off import (
    NO_IPV6_ERRNOS,
    ipv6_problem,
    verify_ipv6_off,
)
from code_reviewer_runner.dynamic_review.netguard import EgressMode, table_name

pytestmark = pytest.mark.skipif(
    EGRESS_MODE is not EgressMode.FALLBACK,
    reason="the fallback pass of the job phase only (CR_PRIVILEGED_EGRESS_MODE=fallback)",
)

IPV6_ATTEMPT = (
    "import errno, socket, sys\n"
    "s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)\n"
    "s.settimeout(2)\n"
    "try:\n"
    "    s.connect((sys.argv[1], 9))\n"
    "except OSError as error:\n"
    "    print(error.errno)\n"
    "else:\n"
    "    print(0)\n"
)


def nft_tables_of(family: str) -> subprocess.CompletedProcess[str]:
    nft = shutil.which("nft", path="/usr/sbin:/sbin:" + TRUSTED_PATH)
    assert nft is not None
    return subprocess.run(
        [nft, "list", "table", family, table_name(ENGINE_UID)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


# #345-T18
def test_the_rules_are_an_ip_table_that_nobody_can_list_and_there_is_no_inet_one() -> None:
    # NET_ADMIN is gone, so listing fails for root as well, in either family; what can be said from
    # here is that nothing changed that.
    assert nft_tables_of("ip").returncode != 0
    assert nft_tables_of("inet").returncode != 0


# #345-T16 #345-T18
def test_ipv6_is_off_in_the_kernels_own_files_and_for_the_engine_user() -> None:
    assert ipv6_problem() is None
    verify_ipv6_off(ENGINE_UID, ENGINE_GID)

    for target in ("::1", "2001:db8::1", "fe80::1"):
        done = run_as(ENGINE_UID, ENGINE_GID, IPV6_ATTEMPT, target)
        assert done.returncode == 0, done.stderr
        assert int(done.stdout) in NO_IPV6_ERRNOS, (target, done.stdout)


# #345-T16
def test_the_engine_user_cannot_bring_ipv6_back() -> None:
    # Only root (or a holder of NET_ADMIN) may write the sysctl; the engine user is neither.
    done = run_as(
        ENGINE_UID,
        ENGINE_GID,
        "open('/proc/sys/net/ipv6/conf/all/disable_ipv6', 'w').write('0\\n')",
    )
    assert done.returncode != 0
    assert ipv6_problem() is None


# #345-T18
def test_a_job_launch_in_fallback_mode_passes_both_proofs_before_its_engine(
    tmp_path: Path,
) -> None:
    launch = EngineLaunch(
        uid=ENGINE_UID,
        gid=ENGINE_GID,
        home=str(tmp_path),
        tmpdir=str(tmp_path),
        config_dir=tmp_path,
        egress_mode=EgressMode.FALLBACK,
    )
    with slot_proxy():
        launch.confine(launch.proxy_port, launch.engine_port)
    launch.close()


# #345-T18: why the proof exists. The user reaches the unfiltered IPv6 world if IPv6 were on; here
# every IPv6 attempt of the engine user ends in an error that only a host without IPv6 gives.
def test_the_errors_that_count_as_no_ipv6_are_the_ones_of_a_host_without_it() -> None:
    assert errno.ECONNREFUSED not in NO_IPV6_ERRNOS
    assert {errno.ENETUNREACH, errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT} == NO_IPV6_ERRNOS
