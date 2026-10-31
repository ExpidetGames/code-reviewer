# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer's agent session against the real, pinned OpenCode (#764).

A scripted model plays one tool call or one text per request; everything else is production: the
engine configuration and environment, the model proxy and ledger, the git workspace with its guard,
the push loop and the leftover handling. The user separation is proven by the privileged lane.
"""

from pathlib import Path

import pytest
from implementer_support import (
    Turned,
    bash,
    commit,
    implementer_turn,
    says,
    write_file,
)

from code_reviewer_runner.implementer.git_workspace import LEFTOVER_MESSAGE
from code_reviewer_runner.implementer.prompts import LEFTOVER_PROMPT
from code_reviewer_runner.result import ErrorCode
from git_support import raw

CLOSING = "I added hello.txt and committed it."


def origin_subjects(turned: Turned) -> list[str]:
    rig = turned.rig
    out = raw(
        "log", "--format=%s", f"main..{turned.workspace.spec.branch}", cwd=rig.origin.path, git=rig.git
    )
    return out.splitlines()


# #764-T03
def test_the_agent_writes_a_file_commits_it_through_bash_and_the_result_lists_it(
    tmp_path: Path,
) -> None:
    with implementer_turn(
        tmp_path, lambda repo: [write_file(repo, "hello.txt"), commit("Add hello"), says(CLOSING)]
    ) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert [c.subject for c in result.commits] == ["Add hello"]
        assert [(f.path, f.kind.value) for f in result.files_changed] == [("hello.txt", "added")]
        assert result.summary == CLOSING
        assert result.pushed and result.head_commit == result.commits[-1].sha
        assert result.base_commit == turned.workspace.start_commit
        assert result.opencode_session_id and result.opencode_version == "1.19.0"
        assert turned.origin_tip() == result.head_commit
        assert origin_subjects(turned) == ["Add hello"]
        assert len(turned.messages) == 1, "a clean tree gets no extra message"
