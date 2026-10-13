# SPDX-License-Identifier: Apache-2.0

"""Pins down the fail-closed startup self-check that gates the `opencode` capability (#195).

A runner advertises `opencode` only after the check proved the dedicated unprivileged user, a
read-only export mechanism and proxy-only egress. A failure drops the capability and names a stable
isolation code; there is no host-setting or fork fallback. The concrete probes are #202's.
"""

import pytest

from code_reviewer_runner.capabilities import (
    ALL_ENGINES,
    ENGINE_DIFF,
    ENGINE_DYNAMIC,
    IsolationFacts,
    IsolationSelfCheckError,
    advertised_engines,
    fail_closed_self_check,
    verify_isolation,
)
from code_reviewer_runner.result import ErrorCode

DEDICATED_UID = 10001


def _ok() -> IsolationFacts:
    return IsolationFacts(
        uid=DEDICATED_UID,
        expected_uid=DEDICATED_UID,
        export_read_only=True,
        egress_proxy_only=True,
    )


# #195-T09: a proven isolation advertises both engines.
def test_a_proven_isolation_advertises_both_engines() -> None:
    assert advertised_engines(lambda: verify_isolation(_ok())) == ALL_ENGINES


# #195-T09
def test_a_missing_or_wrong_uid_never_advertises_opencode() -> None:
    for facts in (
        IsolationFacts(uid=0, expected_uid=0, export_read_only=True, egress_proxy_only=True),
        IsolationFacts(
            uid=1000, expected_uid=DEDICATED_UID, export_read_only=True, egress_proxy_only=True
        ),
    ):
        with pytest.raises(IsolationSelfCheckError) as refused:
            verify_isolation(facts)
        assert refused.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
        assert advertised_engines(lambda f=facts: verify_isolation(f)) == (ENGINE_DIFF,)


# #195-T09
def test_a_writable_export_or_non_proxy_egress_drops_the_capability() -> None:
    writable = IsolationFacts(
        uid=DEDICATED_UID,
        expected_uid=DEDICATED_UID,
        export_read_only=False,
        egress_proxy_only=True,
    )
    open_egress = IsolationFacts(
        uid=DEDICATED_UID,
        expected_uid=DEDICATED_UID,
        export_read_only=True,
        egress_proxy_only=False,
    )
    for facts in (writable, open_egress):
        with pytest.raises(IsolationSelfCheckError) as refused:
            verify_isolation(facts)
        assert refused.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
        engines = advertised_engines(lambda f=facts: verify_isolation(f))
        assert engines == (ENGINE_DIFF,)
        assert ENGINE_DYNAMIC not in engines


# #195-T09: until #202 supplies the probes, the configured check fails closed.
def test_the_configured_self_check_fails_closed() -> None:
    with pytest.raises(IsolationSelfCheckError) as refused:
        fail_closed_self_check()()

    assert refused.value.code is ErrorCode.DYNAMIC_ISOLATION_SELF_CHECK_FAILED
    assert advertised_engines(fail_closed_self_check()) == (ENGINE_DIFF,)
