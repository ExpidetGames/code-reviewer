# SPDX-License-Identifier: Apache-2.0

"""A run that stopped at the token cap of an own key says so (#553): the same fact as a run that
stopped at its cost limit or its time (#293), with a reason of its own."""

from code_reviewer_runner.dynamic_review.wrap_up import STOPPED_EARLY_NOTICES
from code_reviewer_runner.job_loop.reporting import STOPPED_EARLY_REASONS


# #553-R07
def test_the_token_limit_is_a_reason_a_run_may_report_and_the_summary_has_words_for() -> None:
    assert "token_limit" in STOPPED_EARLY_REASONS
    notice = STOPPED_EARLY_NOTICES["token_limit"]
    assert "stopped early" in notice and "token" in notice
    assert set(STOPPED_EARLY_NOTICES) == set(STOPPED_EARLY_REASONS)
