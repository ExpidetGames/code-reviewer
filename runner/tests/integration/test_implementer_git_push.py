# SPDX-License-Identifier: LicenseRef-Proprietary

"""The push side of the Implementer's git workspace (#762): the runner-owned mirror fetches the
agent's branch without force, checks that it still contains the start commit and pushes from the
mirror. The check is the guarantee; the guard hook is only the fast path (the tests that go around
the hook show it)."""

import os
import secrets
import subprocess
from pathlib import Path

import pytest
from git_support import TOKEN, HttpOrigin, raw
from workspace_support import (  # noqa: F401 - rig is a fixture
    BRANCH,
    Rig,
    agent_git,
    rig,
)

from code_reviewer_runner.implementer.git_workspace import (
    GitWorkspace,
    PushLoop,
    PushOutcome,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

NO_HOOKS = ("-c", "core.hooksPath=/dev/null")


def commit(workspace: GitWorkspace, name: str, content: str = "x\n") -> str:
    """A commit made the way the agent does (guard active, signals the spool)."""
    (workspace.repo / name).write_text(content)
    assert agent_git(workspace, "add", "-A").returncode == 0
    done = agent_git(workspace, "commit", "-qm", f"add {name}")
    assert done.returncode == 0, done.stderr
    return raw("rev-parse", "HEAD", cwd=workspace.repo, git=workspace.git)


def bypass(workspace: GitWorkspace, *args: str) -> None:
    """What a hostile agent can do: `-c core.hooksPath=/dev/null` takes the guard away."""
    done = agent_git(workspace, *NO_HOOKS, *args)
    assert done.returncode == 0, done.stderr


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


# #762-T05
def test_a_commit_is_fetched_checked_and_pushed_and_a_second_one_follows(rig: Rig) -> None:
    workspace = rig.prepared()
    first = commit(workspace, "a.txt")

    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert result.head == first
    assert rig.origin.tip(BRANCH) == first
    assert rig.origin.tip("main") == workspace.start_commit
    second = commit(workspace, "b.txt")

    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert rig.origin.tip(BRANCH) == second
    assert workspace.pushed_tip == second


# #762-T05
def test_a_push_with_nothing_new_is_up_to_date(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    workspace.push()

    assert workspace.push().outcome is PushOutcome.UP_TO_DATE


# #762-T05
def test_pushes_are_batched_by_the_injected_interval(rig: Rig) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=120.0, clock=clock)
    assert loop.tick() is None  # nothing signalled yet

    first = commit(workspace, "a.txt")
    result = loop.tick()  # the first push is not held back
    assert result is not None and result.head == first
    second = commit(workspace, "b.txt")
    clock.now += 30
    assert loop.tick() is None, "batched: the interval has not passed"
    assert rig.origin.tip(BRANCH) == first
    clock.now += 100
    result = loop.tick()
    assert result is not None and result.head == second
    assert rig.origin.tip(BRANCH) == second
    assert loop.tick() is None


# #762-T05
def test_the_final_push_is_not_held_back_by_the_interval(rig: Rig) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=120.0, clock=clock)
    commit(workspace, "a.txt")
    assert loop.tick() is not None
    last = commit(workspace, "b.txt")

    result = loop.finish()

    assert result.outcome is PushOutcome.PUSHED
    assert rig.origin.tip(BRANCH) == last


# #762-T05
def test_a_move_of_the_branch_without_a_spool_line_is_found_by_the_poll(rig: Rig) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())
    tip = commit(workspace, "a.txt")
    workspace.spool_path.write_text("")  # the hook's hint is gone; the ref is still polled

    result = loop.tick()

    assert result is not None and result.head == tip


# #762-T06
def test_a_rewrite_of_a_pushed_commit_ends_the_turn_and_origin_keeps_the_last_good_tip(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    bypass(workspace, "commit", "--amend", "-qm", "rewritten")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) == good
    assert workspace.pushed_tip == good


# #762-T06
def test_after_a_violation_nothing_is_pushed_any_more_even_if_the_branch_looks_fine_again(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    bypass(workspace, "reset", "-q", "--hard", workspace.start_commit)
    with pytest.raises(JobError):
        workspace.push()
    bypass(workspace, "reset", "-q", "--hard", good)
    commit(workspace, "c.txt")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) == good


# #762-T06
def test_a_branch_that_no_longer_contains_the_start_is_a_violation_and_nothing_is_pushed(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    empty_tree = raw("hash-object", "-t", "tree", "/dev/null", cwd=workspace.repo, git=rig.git)
    unrelated = raw(
        "commit-tree", empty_tree, "-m", "unrelated", cwd=workspace.repo, git=rig.git
    )
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", unrelated)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) is None
    assert subprocess.run(
        [rig.git, "--git-dir", str(workspace.mirror), "rev-parse", "-q", "--verify", f"refs/heads/{BRANCH}"],
        capture_output=True,
        check=False,
    ).returncode != 0, "the mirror does not keep the rejected tip"


# #762-T06
def test_a_deleted_branch_is_a_violation(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    workspace.push()
    bypass(workspace, "checkout", "-q", "--detach")
    bypass(workspace, "branch", "-D", BRANCH)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION


# #762-T07
def test_a_branch_that_exists_on_origin_with_other_history_is_branch_exists(rig: Rig) -> None:
    workspace = rig.prepared()
    theirs = rig.origin.commit_on(BRANCH, "theirs.txt")
    commit(workspace, "a.txt")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_EXISTS
    assert rig.origin.tip(BRANCH) == theirs


# #762-T07
def test_origin_moving_on_after_our_first_push_is_a_rejected_push(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    workspace.push()
    theirs = rig.origin.commit_on(BRANCH, "theirs.txt")
    commit(workspace, "b.txt")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert rig.origin.tip(BRANCH) == theirs


# #762-T07
def test_origin_refusing_a_workflow_file_is_a_rejected_push(rig: Rig) -> None:
    workspace = rig.prepared()
    rig.origin.reject_with_hook("refusing to allow a GitHub App to create or update workflow")
    (workspace.repo / ".github" / "workflows").mkdir(parents=True)
    commit(workspace, ".github/workflows/ci.yml", "on: push\n")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert "workflow" in refused.value.detail
    assert rig.origin.tip(BRANCH) is None


# #762-T07
def test_a_failed_push_never_names_the_token(rig: Rig) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git=git)
        workspace.clone_mirror()
        server.token = "ghs_somethingElse0123456789abcdef"  # the credential stops working
        workspace.create_agent_repository()
        workspace.install_guard()
        commit(workspace, "a.txt")

        with pytest.raises(JobError) as refused:
            workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert TOKEN not in str(refused.value)


# #762-T07
def test_a_push_over_http_authenticates_with_the_token_and_not_in_argv(rig: Rig) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git=git)
        workspace.clone_mirror()
        workspace.create_agent_repository()
        workspace.install_guard()
        tip = commit(workspace, "a.txt")

        workspace.push()

    assert rig.origin.tip(BRANCH) == tip
    assert all(header is not None for _, header in server.requests)


# #762-T12
def test_a_forged_spool_line_costs_one_verified_attempt_and_changes_no_ref(rig: Rig) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock)
    tip = commit(workspace, "a.txt")
    assert loop.tick() is not None
    before = workspace.verifications
    refs = raw("for-each-ref", cwd=workspace.mirror, git=rig.git)
    with workspace.spool_path.open("a") as spool:
        spool.write("1.0 " + "f" * 40 + "\n")
        spool.write("garbage that is not a line\n")
        spool.write("\x00\x01" * 100 + "\n")

    result = loop.tick()

    assert result is not None and result.outcome is PushOutcome.UP_TO_DATE
    assert workspace.verifications == before + 1
    assert raw("for-each-ref", cwd=workspace.mirror, git=rig.git) == refs
    assert rig.origin.tip(BRANCH) == tip
    assert loop.tick() is None, "the forged lines were read once"


# #762-T12
def test_a_spool_that_grows_without_bound_is_cut_by_the_runner(rig: Rig) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())
    with workspace.spool_path.open("a") as spool:
        spool.write(("1.0 " + "a" * 40 + "\n") * 40_000)  # about 1.6 MB

    loop.tick()

    assert workspace.spool_path.stat().st_size < 1_000_000


# #762-T13
def test_no_commits_and_a_clean_tree_is_nothing_to_push_and_no_ref_on_origin(rig: Rig) -> None:
    workspace = rig.prepared()

    result = workspace.push()

    assert result.outcome is PushOutcome.NOTHING_TO_PUSH
    assert result.head is None
    assert rig.origin.tip(BRANCH) is None


# #762-T13
def test_the_final_push_of_a_turn_without_commits_creates_nothing(rig: Rig) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())

    assert loop.finish().outcome is PushOutcome.NOTHING_TO_PUSH
    assert rig.origin.tip(BRANCH) is None


# #762-T14
def test_binary_and_large_commits_are_pushed_and_the_shallow_mirror_passes_the_check(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    blob = secrets.token_bytes(6 * 1024 * 1024)
    (workspace.repo / "data.bin").write_bytes(blob)
    (workspace.repo / "big.txt").write_text("line of text\n" * 200_000)
    assert agent_git(workspace, "add", "-A").returncode == 0
    assert agent_git(workspace, "commit", "-qm", "big").returncode == 0
    tip = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)

    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert rig.origin.tip(BRANCH) == tip
    size = raw("cat-file", "-s", f"{tip}:data.bin", cwd=rig.origin.seed, git=rig.git, GIT_DIR=str(rig.origin.path))
    assert int(size) == len(blob)
    assert (Path(workspace.mirror) / "shallow").exists(), "the mirror is a depth 1 clone"
    assert os.environ.get("GIT_DIR") is None


# #762-T09
def test_the_runner_never_executes_the_config_of_the_agent_repository(rig: Rig, tmp_path: Path) -> None:
    workspace = rig.prepared()
    marker = tmp_path / "marker"
    script = tmp_path / "trap.sh"
    script.write_text(f"#!/bin/sh\ntouch {marker}\nexit 0\n")
    script.chmod(0o755)
    config = workspace.repo / ".git" / "config"
    config.write_text(
        config.read_text()
        + f"[core]\n\tfsmonitor = {script}\n\tsshCommand = {script}\n"
        + f"[alias]\n\tstatus = !{script}\n"
        + f"[uploadpack]\n\tpackObjectsHook = {script}\n"
    )
    hooks = workspace.repo / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    for name in ("pre-push", "post-checkout", "reference-transaction", "pre-auto-gc"):
        (hooks / name).write_bytes(script.read_bytes())
        (hooks / name).chmod(0o755)
    commit_ref = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    (workspace.repo / "a.txt").write_text("a\n")
    agent_env = workspace.agent_environment()
    subprocess.run(
        [rig.git, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "add", "-A"],
        cwd=workspace.repo, env=agent_env, check=True, capture_output=True,
    )
    subprocess.run(
        [rig.git, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "commit", "-qm", "x"],
        cwd=workspace.repo, env=agent_env, check=True, capture_output=True,
    )
    assert commit_ref != raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    marker.unlink(missing_ok=True)

    workspace.agent_tip()
    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert not marker.exists(), "a root operation ran something the agent configured"
