# SPDX-License-Identifier: Apache-2.0

"""The self-check refuses a process that still holds the startup capabilities (#202-T09).

The startup phase runs with the capabilities the container is created with, `NET_ADMIN` and
`SETPCAP` included. A check made in that state, before the production startup step dropped them,
must fail on exactly that property and never advertise `opencode`.
"""

import pytest
from privileged_support import ENGINE_GID, ENGINE_UID, PROXY_PORT

from code_reviewer_runner.capabilities import ENGINE_DIFF, self_check_outcome
from code_reviewer_runner.dynamic_review.self_check import (
    SelfCheckFailed,
    SelfCheckReason,
    check_dynamic_runner,
)
from code_reviewer_runner.dynamic_review.static_isolation import DEFAULT_ENGINE_PORT, SlotPorts


def held() -> None:
    check_dynamic_runner(
        user=(ENGINE_UID, ENGINE_GID),
        ports=SlotPorts(PROXY_PORT, DEFAULT_ENGINE_PORT),
        rules_installed=True,
    )


# #202-T09
def test_a_process_that_still_holds_net_admin_is_not_capable() -> None:
    with pytest.raises(SelfCheckFailed) as caught:
        held()

    assert caught.value.reason is SelfCheckReason.CAPABILITIES_NOT_DROPPED


# #202-T09
def test_the_outcome_of_such_a_check_is_diff_only() -> None:
    engines, error = self_check_outcome(held)

    assert engines == (ENGINE_DIFF,)
    assert error is not None
