# SPDX-License-Identifier: Apache-2.0
"""Every checkout failure names a stable reason, so an operator can tell the failures apart."""

import hashlib
import struct
from pathlib import Path

import pytest

from code_reviewer_runner.dynamic_review.evidence import tracked_tree
from code_reviewer_runner.dynamic_review.limits import (
    Budget,
    CheckoutError,
    CheckoutReason,
    Limits,
)
from code_reviewer_runner.dynamic_review.objects import ObjectStore
from code_reviewer_runner.dynamic_review.paths import validate_path
from code_reviewer_runner.dynamic_review.protocol import Packets
from code_reviewer_runner.result import ErrorCode


def _reason(error: pytest.ExceptionInfo[CheckoutError]) -> CheckoutReason:
    return error.value.reason


# #296-T08
def test_the_reason_set_is_the_documented_stable_one() -> None:
    assert {reason.value for reason in CheckoutReason} == {
        "invalid_request",
        "ref_moved",
        "ref_missing",
        "protocol",
        "pack_invalid",
        "object_missing",
        "tree_invalid",
        "entries",
        "path_invalid",
        "budget_transfer",
        "budget_preparation",
        "budget_exposed",
        "diff_too_large",
        "input_too_large",
        "cancelled",
        "timeout",
        "transport",
        "isolation",
        "context",
    }


# #296-T08
def test_a_reason_keeps_the_error_code_a_caller_branches_on() -> None:
    error = CheckoutError(CheckoutReason.TRANSPORT, ErrorCode.GIT_RATE_LIMIT)
    assert error.code is ErrorCode.GIT_RATE_LIMIT
    assert error.reason is CheckoutReason.TRANSPORT
    assert CheckoutError(CheckoutReason.REF_MOVED).code is ErrorCode.CHECKOUT_INCOMPLETE
    assert str(CheckoutError(CheckoutReason.REF_MOVED)) == "checkout_incomplete"


# #296-T08
def test_budget_failures_name_which_budget_ran_out() -> None:
    budget = Budget(Limits(preparation_bytes=10, exposed_bytes=10))
    with pytest.raises(CheckoutError) as preparation:
        budget.charge(11)
    with pytest.raises(CheckoutError) as exposed:
        budget.charge(11, exposed=True)
    assert _reason(preparation) is CheckoutReason.BUDGET_PREPARATION
    assert _reason(exposed) is CheckoutReason.BUDGET_EXPOSED


# #296-T08
def test_cancellation_and_the_deadline_have_their_own_reasons(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(CheckoutError) as cancelled:
        Budget(Limits(), cancelled=lambda: True).check()
    assert _reason(cancelled) is CheckoutReason.CANCELLED
    now = 10.0
    monkeypatch.setattr("code_reviewer_runner.dynamic_review.limits.time.monotonic", lambda: now)
    budget = Budget(Limits(seconds=1))
    now = 12.0
    with pytest.raises(CheckoutError) as timed_out:
        budget.check()
    assert _reason(timed_out) is CheckoutReason.TIMEOUT
    assert timed_out.value.code is ErrorCode.TIMEOUT


# #296-T08
def test_an_invalid_path_is_path_invalid() -> None:
    with pytest.raises(CheckoutError) as error:
        validate_path("a/../b", Limits())
    assert _reason(error) is CheckoutReason.PATH_INVALID


# #296-T08
def test_a_corrupt_pack_is_pack_invalid(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path / "objects", Budget(Limits()))
    payload = b"PACK" + struct.pack(">II", 2, 0)
    with pytest.raises(CheckoutError) as bad_checksum:
        store.unpack(payload + b"x" * 20)
    assert _reason(bad_checksum) is CheckoutReason.PACK_INVALID
    too_many = b"PACK" + struct.pack(">II", 2, 20_000 * 4 + 1)
    with pytest.raises(CheckoutError) as count:
        store.unpack(too_many + hashlib.sha1(too_many).digest())
    assert _reason(count) is CheckoutReason.ENTRIES


# #296-T08
def test_a_missing_object_is_object_missing(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path / "objects", Budget(Limits()))
    with pytest.raises(CheckoutError) as error:
        store.read("a" * 40, "blob")
    assert _reason(error) is CheckoutReason.OBJECT_MISSING


# #296-T08
def test_a_tree_with_too_many_entries_is_entries(tmp_path: Path) -> None:
    store = ObjectStore(tmp_path / "objects", Budget(Limits(entries=2)))
    blob = store.put("blob", b"x")
    tree = store.put("tree", b"".join(b"100644 f%d\0" % i + bytes.fromhex(blob) for i in range(3)))
    commit = store.put("commit", f"tree {tree}\n\nmessage\n".encode())
    with pytest.raises(CheckoutError) as error:
        tracked_tree(store, commit)
    assert _reason(error) is CheckoutReason.ENTRIES


# #296-T08
@pytest.mark.parametrize("stream", [[b"zzzz"], [b"0003"], [b"ffff"]])
def test_a_malformed_frame_is_protocol(stream: list[bytes]) -> None:
    with pytest.raises(CheckoutError) as error:
        list(Packets((part for part in stream), Budget(Limits())).packets())
    assert _reason(error) is CheckoutReason.PROTOCOL
