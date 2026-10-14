# SPDX-License-Identifier: Apache-2.0

"""The Dynamic publisher against a real GitHub comment API on loopback (#199).

Covers the persistent-comment behaviour end to end: one comment is created and then edited across
pushes, a human or foreign-bot marker is ignored, a corrupt state fails closed, pagination is
followed, an ambiguous create is not duplicated, a stale result is refused, and a resolved history
of more than 20 entries survives with every id and detail.
"""

from collections.abc import Iterator

import pytest
from fake_github_comments import FakeGithubComments

from code_reviewer_runner.dynamic_findings import DynamicFindings, Finding
from code_reviewer_runner.dynamic_review.github import (
    GitHubError,
    HttpCommentsClient,
)
from code_reviewer_runner.dynamic_review.publish import (
    IDENTITY_MARKER,
    Publisher,
    PublishError,
)
from code_reviewer_runner.dynamic_review.state import (
    MARKER_PREFIX,
    MARKER_SUFFIX,
    decode_state,
)
from code_reviewer_runner.dynamic_review.wrap_up import STOPPED_EARLY_NOTICES
from code_reviewer_runner.result import ErrorCode

TOKEN = "ghs_fake-installation-token-0123456789"
BOT = "code-reviewer[bot]"
REPO = "acme/repo"
PR = 1
SHA = "1" * 40
NEXT = "2" * 40
THIRD = "3" * 40


def finding(finding_id: str = "f-1", *, sha: str = SHA, **overrides: object) -> Finding:
    base: dict[str, object] = {
        "id": finding_id,
        "priority": "P1",
        "confidence": 0.5,
        "title": "A finding",
        "body": "why it is a defect",
        "path": "src/a.ts",
        "line_start": 1,
        "line_end": 2,
        "evidence": ("src/a.ts:1",),
        "reviewed_sha": sha,
    }
    base.update(overrides)
    return Finding(**base)  # type: ignore[arg-type]


def run(
    *findings: Finding,
    resolved: tuple[str, ...] = (),
    sha: str = SHA,
    stopped_early: str | None = None,
) -> DynamicFindings:
    return DynamicFindings(
        reviewed_sha=sha, findings=findings, resolved_ids=resolved, stopped_early=stopped_early
    )


@pytest.fixture
def server() -> Iterator[FakeGithubComments]:
    fake = FakeGithubComments(token=TOKEN, bot_login=BOT)
    yield fake
    fake.stop()


@pytest.fixture
def publisher(server: FakeGithubComments) -> Publisher:
    client = HttpCommentsClient(server.url, REPO, TOKEN)
    return Publisher(
        client=client,
        bot_login=BOT,
        repository=REPO,
        pr_number=PR,
        web_base="https://github.com",
    )


# #199-T01
def test_one_comment_is_created_then_edited_across_pushes(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    first = publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    assert first.created is True
    assert len(server.comments) == 1
    assert server.comments[0]["body"].count(IDENTITY_MARKER) == 1

    second = publisher.publish(
        run(finding("f-1", sha=NEXT, line_start=9, line_end=12), sha=NEXT),
        head_sha=NEXT,
        previous_reviewed_sha=SHA,
    )
    assert second.created is False
    assert second.comment_url == first.comment_url
    assert len(server.comments) == 1

    third = publisher.publish(
        run(resolved=("f-1",), sha=THIRD), head_sha=THIRD, previous_reviewed_sha=NEXT
    )
    assert third.created is False
    assert len(server.comments) == 1
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert state.reviewed_sha == THIRD
    assert state.findings == ()
    assert [entry.finding.id for entry in state.resolved] == ["f-1"]

    # Only issue comments were touched: no reviews, labels or pull-request edits.
    assert all("/issues/" in path for _, path in server.requests)


# #293-T07
def test_a_review_that_stopped_early_is_published_with_the_notice_and_the_next_one_drops_it(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    early = publisher.publish(
        run(finding(), stopped_early="cost_limit"), head_sha=SHA, previous_reviewed_sha=None
    )
    assert early.created is True
    assert STOPPED_EARLY_NOTICES["cost_limit"] in server.comments[0]["body"]

    publisher.publish(
        run(finding("f-1", sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA
    )

    assert len(server.comments) == 1
    assert "stopped early" not in server.comments[0]["body"]


# #199-T01
def test_a_finding_omitted_in_a_later_push_survives_the_write_and_the_next_read(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)

    # Push 2 does not mention f-1 at all: omitted is not resolved, it stays active at its own head.
    publisher.publish(
        run(finding("f-2", sha=NEXT, path="src/b.ts", title="Another"), sha=NEXT),
        head_sha=NEXT,
        previous_reviewed_sha=SHA,
    )
    written = decode_state(server.comments[0]["body"])
    assert written is not None
    assert {item.id: item.reviewed_sha for item in written.findings} == {"f-2": NEXT, "f-1": SHA}

    # Push 3 must read that state back and update it.
    publisher.publish(run(resolved=("f-1",), sha=THIRD), head_sha=THIRD, previous_reviewed_sha=NEXT)
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert state.reviewed_sha == THIRD
    assert [item.id for item in state.findings] == ["f-2"]
    assert [entry.finding.id for entry in state.resolved] == ["f-1"]
    assert len(server.comments) == 1


# #199-T10
def test_twenty_carried_and_twenty_new_findings_leave_an_updatable_comment(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    def batch(prefix: str, sha: str) -> tuple[Finding, ...]:
        return tuple(
            finding(f"{prefix}-{i}", sha=sha, title=f"{prefix} {i}", path=f"src/{prefix}{i}.ts")
            for i in range(20)
        )

    publisher.publish(run(*batch("old", SHA)), head_sha=SHA, previous_reviewed_sha=None)
    publisher.publish(run(*batch("new", NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA)

    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert len(state.findings) == 30
    assert state.omitted_findings == 10
    assert "10 further findings not shown" in server.comments[0]["body"]
    assert state.resolved == ()

    # The next push can still read, reconcile and write it.
    publisher.publish(
        run(resolved=("new-0",), sha=THIRD), head_sha=THIRD, previous_reviewed_sha=NEXT
    )
    later = decode_state(server.comments[0]["body"])
    assert later is not None
    assert later.reviewed_sha == THIRD
    assert [entry.finding.id for entry in later.resolved] == ["new-0"]
    assert len(server.comments) == 1


# #199-T04
def test_a_human_or_foreign_marker_never_authorizes_an_edit(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    human = server.seed(IDENTITY_MARKER + "\nI am not the bot", author="alice")
    foreign = server.seed(IDENTITY_MARKER + "\nother bot", author="other-bot[bot]")

    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)

    human_body = next(item["body"] for item in server.comments if item["id"] == human["id"])
    foreign_body = next(item["body"] for item in server.comments if item["id"] == foreign["id"])
    assert human_body == IDENTITY_MARKER + "\nI am not the bot"
    assert foreign_body == IDENTITY_MARKER + "\nother bot"
    assert len(server.comments) == 3


# #199-T04
@pytest.mark.parametrize(
    ("user_type", "app_slug"),
    [("User", None), ("Bot", "some-other-app")],
)
def test_a_comment_with_the_bot_login_but_another_kind_of_author_is_not_ours(
    server: FakeGithubComments, publisher: Publisher, user_type: str, app_slug: str | None
) -> None:
    seeded = server.seed(
        IDENTITY_MARKER + "\nnot ours", author=BOT, user_type=user_type, app_slug=app_slug
    )

    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)

    untouched = next(item["body"] for item in server.comments if item["id"] == seeded["id"])
    assert untouched == IDENTITY_MARKER + "\nnot ours"
    assert len(server.comments) == 2


# #199-T04
def test_a_bot_comment_without_app_metadata_is_still_ours_by_login_and_type(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    server.comments[0]["performed_via_github_app"] = None

    publisher.publish(
        run(finding("f-1", sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA
    )

    assert len(server.comments) == 1
    state = decode_state(server.comments[0]["body"])
    assert state is not None and state.reviewed_sha == NEXT


# #199-T04
def test_a_corrupt_bot_state_fails_closed_without_rewriting_history(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    corrupt = server.seed(f"{IDENTITY_MARKER}\n\n{MARKER_PREFIX}AAAA{MARKER_SUFFIX}", author=BOT)

    with pytest.raises(PublishError) as refused:
        publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)

    assert refused.value.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
    unchanged = next(item["body"] for item in server.comments if item["id"] == corrupt["id"])
    assert unchanged == corrupt["body"]


# #199-T04
def test_the_summary_is_found_on_a_later_page(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    for index in range(150):
        server.seed(f"filler comment {index}", author="alice")
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    assert len(server.comments) == 151

    publisher.publish(
        run(finding("f-1", sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA
    )

    bot_comments = [item for item in server.comments if item["user"]["login"] == BOT]
    assert len(bot_comments) == 1


# #199-T03
def test_more_than_twenty_resolved_findings_survive_losslessly(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    ids = [f"f-{index}" for index in range(25)]
    prior = run(
        *[
            finding(finding_id, title=f"Finding {finding_id}", path=f"src/{finding_id}.ts")
            for finding_id in ids
        ]
    )
    publisher.publish(prior, head_sha=SHA, previous_reviewed_sha=None)

    new = finding(
        "fresh",
        sha=NEXT,
        priority="P0",
        confidence=0.9,
        evidence=("src/b.ts:7",),
    )
    publisher.publish(
        run(new, resolved=tuple(ids), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA
    )

    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert [entry.finding.id for entry in state.resolved] == ids
    assert all(entry.resolved_sha == NEXT for entry in state.resolved)
    assert all(entry.finding.priority == "P1" for entry in state.resolved)
    assert [item.id for item in state.findings] == ["fresh"]
    assert state.findings[0].priority == "P0"
    assert state.findings[0].confidence == 0.9
    assert state.findings[0].evidence == ("src/b.ts:7",)


# #199-T07
@pytest.mark.parametrize(
    ("status", "headers", "expected"),
    [
        (401, {}, ErrorCode.GIT_AUTH),
        (403, {"X-RateLimit-Remaining": "0"}, ErrorCode.GIT_RATE_LIMIT),
        (403, {}, ErrorCode.GIT_FORBIDDEN),
        (429, {}, ErrorCode.GIT_RATE_LIMIT),
        (500, {}, ErrorCode.GIT_UNAVAILABLE),
    ],
)
def test_github_failures_become_stable_codes(
    server: FakeGithubComments,
    publisher: Publisher,
    status: int,
    headers: dict[str, str],
    expected: ErrorCode,
) -> None:
    server.faults["GET"] = (status, headers)

    with pytest.raises(PublishError) as refused:
        publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)

    assert refused.value.code is expected


# #199-T07
def test_an_ambiguous_create_is_not_duplicated(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    server.ambiguous_create = True

    published = publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)

    assert published.created is True
    assert len(server.comments) == 1
    assert decode_state(server.comments[0]["body"]) is not None


# #199-T07
def test_a_lost_create_without_a_comment_is_a_failure(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    server.faults["POST"] = (503, {})

    with pytest.raises(PublishError) as refused:
        publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)

    assert refused.value.code is ErrorCode.GIT_UNAVAILABLE
    assert server.comments == []


# #199-T08
def test_a_newer_published_review_is_not_overwritten(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(
        run(finding(sha=THIRD), sha=THIRD), head_sha=THIRD, previous_reviewed_sha=None
    )
    before = server.comments[0]["body"]

    with pytest.raises(PublishError) as refused:
        publisher.publish(
            run(finding(sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA
        )

    assert refused.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert server.comments[0]["body"] == before


# #199-T08
def test_a_predecessor_that_published_before_losing_its_lease_is_refused_not_reconciled(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    # The predecessor reviewed NEXT and wrote it, but this claim does not name NEXT as attempted.
    publisher.publish(run(finding(sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA)
    before = server.comments[0]["body"]

    with pytest.raises(PublishError) as refused:
        publisher.publish(
            run(finding(sha=THIRD), sha=THIRD), head_sha=THIRD, previous_reviewed_sha=SHA
        )

    assert refused.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert server.comments[0]["body"] == before


# #255-T01
def test_a_run_that_published_and_then_failed_is_reconciled_from_by_the_next_push(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    # NEXT published and then ended failed: the app never recorded it as reviewed, but it did
    # attempt that head, and says so in the claim.
    publisher.publish(
        run(finding("f-2", sha=NEXT, path="src/b.ts", title="Another"), sha=NEXT),
        head_sha=NEXT,
        previous_reviewed_sha=SHA,
    )
    first_url = server.comments[0]["html_url"]

    published = publisher.publish(
        run(resolved=("f-2",), sha=THIRD),
        head_sha=THIRD,
        previous_reviewed_sha=SHA,
        attempted_shas=(NEXT,),
    )

    assert published.created is False
    assert published.comment_url == first_url
    assert len(server.comments) == 1
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert state.reviewed_sha == THIRD
    # Resolved only because this run named it; the finding it did not name stays active.
    assert [item.id for item in state.findings] == ["f-1"]
    assert [entry.finding.id for entry in state.resolved] == ["f-2"]


# #255-T02
def test_a_head_the_app_never_attempted_still_fails_closed(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    publisher.publish(run(finding(sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA)
    before = server.comments[0]["body"]

    # The claim names other attempted heads, not the one the comment holds.
    with pytest.raises(PublishError) as refused:
        publisher.publish(
            run(finding(sha=THIRD), sha=THIRD),
            head_sha=THIRD,
            previous_reviewed_sha=SHA,
            attempted_shas=("9" * 40, "8" * 40),
        )

    assert refused.value.code is ErrorCode.REVIEW_NOT_PUBLISHED
    assert server.comments[0]["body"] == before


# #255-T02
def test_a_foreign_comment_with_an_attempted_head_is_still_not_the_state(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    forged = server.comments[0]["body"].replace(SHA, NEXT)
    server.comments.clear()
    server.seed(forged, author="mallory")

    published = publisher.publish(
        run(finding(sha=THIRD), sha=THIRD),
        head_sha=THIRD,
        previous_reviewed_sha=None,
        attempted_shas=(NEXT,),
    )

    # The human copy is ignored: the bot writes its own comment next to it.
    assert published.created is True
    assert len(server.comments) == 2


# #255-T03
def test_a_lost_edit_response_is_recognised_on_re_read(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    first = publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    server.ambiguous_edit = True

    published = publisher.publish(
        run(finding(sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA
    )

    assert published.created is False
    assert published.comment_url == first.comment_url
    assert len(server.comments) == 1
    state = decode_state(server.comments[0]["body"])
    assert state is not None
    assert state.reviewed_sha == NEXT


# #255-T03
def test_a_lost_edit_that_did_not_land_is_a_failure(
    server: FakeGithubComments, publisher: Publisher
) -> None:
    publisher.publish(run(finding()), head_sha=SHA, previous_reviewed_sha=None)
    before = server.comments[0]["body"]
    server.faults["PATCH"] = (503, {})

    with pytest.raises(PublishError) as refused:
        publisher.publish(
            run(finding(sha=NEXT), sha=NEXT), head_sha=NEXT, previous_reviewed_sha=SHA
        )

    assert refused.value.code is ErrorCode.GIT_UNAVAILABLE
    assert server.comments[0]["body"] == before


def test_the_client_rejects_a_body_over_the_size_limit(server: FakeGithubComments) -> None:
    client = HttpCommentsClient(server.url, REPO, TOKEN)
    with pytest.raises(GitHubError) as refused:
        client.create_comment(PR, "x" * (65 * 1024))
    assert refused.value.code is ErrorCode.REVIEW_TEXT_TRUNCATED
