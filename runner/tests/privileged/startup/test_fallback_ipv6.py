# SPDX-License-Identifier: Apache-2.0

"""IPv6 off and proven off, against the real kernel (#345-T16).

The fallback ruleset is an `ip`-family table and does not see IPv6, so the runner switches IPv6 off
and proves it (`ipv6_off.py`). The unit tests pin the logic against a fake `/proc`; this is the
real kernel's answer: what its files look like once the production step has run, that the engine
user's IPv6 attempts end in an error only a host without IPv6 gives, and that the proof notices
when IPv6 is on. It is a startup-phase test because it flips the namespace's IPv6 settings, which
needs `NET_ADMIN`; every test puts them back.
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from privileged_support import (
    ENGINE_GID,
    ENGINE_UID,
    ipv6_settings_restored,
    ipv6_switched_off,
    run_as,
)

from code_reviewer_runner.dynamic_review.ipv6_off import (
    NO_IPV6_ERRNOS,
    ipv6_problem,
    verify_ipv6_off,
)
from code_reviewer_runner.dynamic_review.netguard import IsolationError

CONF = Path("/proc/sys/net/ipv6/conf")
ATTEMPT = (
    "import socket, sys\n"
    "s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)\n"
    "s.settimeout(2)\n"
    "try:\n"
    "    s.connect((sys.argv[1], 9))\n"
    "except OSError as error:\n"
    "    print(error.errno)\n"
    "else:\n"
    "    print(0)\n"
)


@pytest.fixture(autouse=True)
def the_kernel_has_ipv6() -> Iterator[None]:
    if not CONF.is_dir():
        pytest.fail(
            "this kernel has no IPv6: the proof of the fallback cannot be judged against it "
            "(CI hosts have IPv6 support; do not boot them with ipv6.disable=1)"
        )
    with ipv6_settings_restored():
        yield


def switch_on() -> None:
    for name in ("default", "all"):
        (CONF / name / "disable_ipv6").write_text("0\n")


# #345-T16
def test_after_the_production_step_the_kernels_own_files_show_no_ipv6() -> None:
    with ipv6_switched_off():
        assert ipv6_problem() is None, ipv6_problem()
        assert Path("/proc/net/if_inet6").read_text().strip() == ""


# #345-T16
def test_the_engine_user_cannot_use_ipv6_once_it_is_off_and_the_proof_passes() -> None:
    with ipv6_switched_off():
        verify_ipv6_off(ENGINE_UID, ENGINE_GID)
        for target in ("::1", "2001:db8::1"):
            done = run_as(ENGINE_UID, ENGINE_GID, ATTEMPT, target)
            assert done.returncode == 0, done.stderr
            assert int(done.stdout) in NO_IPV6_ERRNOS, (target, done.stdout)


# #345-T16
def test_the_proof_fails_while_ipv6_is_on() -> None:
    switch_on()

    with pytest.raises(IsolationError) as caught:
        verify_ipv6_off(ENGINE_UID, ENGINE_GID)

    assert "IPv6" in caught.value.detail or "IPv6" in str(caught.value)
    assert ipv6_problem() is not None


# #345-T16: a single interface left on is enough to fail it.
def test_the_proof_fails_when_one_interface_is_left_on() -> None:
    with ipv6_switched_off():
        (CONF / "lo" / "disable_ipv6").write_text("0\n")

        with pytest.raises(IsolationError):
            verify_ipv6_off(ENGINE_UID, ENGINE_GID)
