# SPDX-License-Identifier: LicenseRef-Proprietary

"""The pure parts of the Implementer's git workspace (#762): how the guard's configuration is
written, how the spool is read, how a git version is judged and what a workspace refuses to be
built with."""

import re
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.git_process import MIN_GIT_VERSION, parse_git_version
from code_reviewer_runner.implementer.git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.implementer.guard_files import (
    parse_spool,
    system_gitconfig_text,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode

SHA = "a" * 40


# #762-T02
def test_the_system_git_config_points_at_the_hooks_and_trusts_the_repository() -> None:
    text = system_gitconfig_text(Path("/opt/code-reviewer/guard"), [Path("/work/repo")])

    assert 'hooksPath = "/opt/code-reviewer/guard"' in text
    assert 'directory = "/work/repo"' in text


# #762-T12
def test_the_spool_lines_that_look_like_a_tip_update_are_read_and_the_rest_ignored() -> None:
    text = (
        f"1700000000.123 {SHA}\nnot a line\n\n17.5 {'b' * 40} extra\n9 {'c' * 39}\n12 {'d' * 40}\n"
    )

    assert parse_spool(text) == [(1700000000.123, SHA), (12.0, "d" * 40)]


# #762-T12
def test_a_spool_of_binary_garbage_gives_no_entries() -> None:
    assert parse_spool("\x00\x01\xff" * 1000) == []


# #762-T11
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("git version 2.53.0", (2, 53, 0)),
        ("git version 2.43.0\n", (2, 43, 0)),
        ("git version 2.39.5 (Apple Git-154)", (2, 39, 5)),
        ("git version 3.0", (3, 0)),
        ("nonsense", None),
        ("", None),
    ],
)
def test_the_git_version_is_read_from_its_banner(
    text: str, expected: tuple[int, ...] | None
) -> None:
    assert parse_git_version(text) == expected


# #762-T11
def test_the_minimum_git_is_2_53() -> None:
    assert MIN_GIT_VERSION == (2, 53)
    below: tuple[int, ...] = (2, 52, 9)
    above: tuple[int, ...] = (2, 53, 0)
    assert below < MIN_GIT_VERSION <= above
    assert re.fullmatch(r"\d+\.\d+", ".".join(map(str, MIN_GIT_VERSION)))


def _workspace(tmp_path: Path, **overrides: object) -> GitWorkspace:
    layout = WorkspaceLayout(
        work_dir=tmp_path / "work",
        run_dir=tmp_path / "run",
        guard_dir=tmp_path / "guard",
        agent_home=tmp_path / "home",
    )
    spec = WorkspaceSpec(
        clone_url=str(overrides.pop("clone_url", "https://github.com/acme/widgets.git")),
        token="ghs_token",
        base_branch="main",
        branch="implementer/a1",
    )
    agent = overrides.pop("agent", AgentUser(uid=10101, gid=10101))
    assert isinstance(agent, AgentUser)
    return GitWorkspace(
        spec,
        layout,
        agent,
        GitIdentity("Implementer", "i@example.invalid"),
        **overrides,  # type: ignore[arg-type]
    )


# #762-T10
def test_the_agent_is_never_root(tmp_path: Path) -> None:
    for uid, gid in ((0, 10101), (10101, 0)):
        with pytest.raises(JobError) as refused:
            _workspace(tmp_path, agent=AgentUser(uid=uid, gid=gid))
        assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID


# #762-T10
@pytest.mark.parametrize(
    "url",
    [
        "http://github.com/acme/widgets.git",
        "git://github.com/acme/widgets.git",
        "ssh://git@github.com/acme/widgets.git",
        "ext::sh -c id",
        "file:///etc",
        "/etc",
        "https://user:pw@github.com/acme/widgets.git",
        "https://github.com/acme/widgets.git?x=1",
        "https://",
        "",
    ],
)
def test_only_an_https_address_without_credentials_is_accepted_by_default(
    tmp_path: Path, url: str
) -> None:
    with pytest.raises(JobError) as refused:
        _workspace(tmp_path, clone_url=url)

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert "user:pw" not in str(refused.value)


# #762-T10
def test_an_https_address_is_accepted(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)

    assert workspace.mirror == tmp_path / "work" / "mirror.git"
    assert workspace.repo == tmp_path / "work" / "repo"
