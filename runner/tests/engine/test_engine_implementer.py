# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer's agent session against the real, pinned OpenCode (#764).

A scripted model plays one tool call or one text per request; everything else is production: the
engine configuration and environment, the model proxy and ledger, the git workspace with its guard,
the push loop and the leftover handling. The user separation is proven by the privileged lane.
"""

import json
from fractions import Fraction
from pathlib import Path
from typing import Any, cast

import pytest
from fake_llm import real_anthropic_usage
from fakes.llm.anthropic_cache import PromptCache
from fakes.wire.formats import Turn
from implementer_support import (
    Scene,
    Turned,
    bash,
    commit,
    implementer_turn,
    says,
    write_file,
)
from native_full_job import BOOK
from opencode_native import REAL_KEY
from opencode_support import ripgrep_binary

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from code_reviewer_runner.implementer.git_workspace import LEFTOVER_MESSAGE
from code_reviewer_runner.implementer.prompts import LEFTOVER_PROMPT, SYSTEM_PROMPT
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, raw
from passthrough_expect import usage_expected
from usage_calc import expected_cost

CLOSING = "I added hello.txt and committed it."


def origin_subjects(turned: Turned) -> list[str]:
    rig = turned.rig
    out = raw(
        "log",
        "--format=%s",
        f"main..{turned.workspace.spec.branch}",
        cwd=rig.origin.path,
        git=rig.git,
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


def committed_by_the_system(turned: Turned) -> list[str]:
    return [c.sha for c in turned.result.commits if c.subject == LEFTOVER_MESSAGE]


# #764-T05
def test_a_dirty_tree_gets_exactly_one_more_message_in_the_same_session_and_no_system_commit(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "hello.txt"),
            says("Done, I think."),
            commit("Add hello"),  # the answer to the extra message
            says("Committed."),
        ]

    with implementer_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert len(turned.messages) == 2
        assert turned.messages[0][0] == turned.messages[1][0], "the same session"
        assert turned.messages[1][1] == LEFTOVER_PROMPT
        assert [c.subject for c in result.commits] == ["Add hello"]
        assert committed_by_the_system(turned) == []
        assert result.summary == "Done, I think.", "the summary is the closing text of the work"
        assert turned.origin_tip() == result.head_commit


# #764-T05
def test_a_tree_that_is_still_dirty_after_the_extra_message_is_committed_by_the_system(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, "hello.txt"), says("Done."), says("I will not commit.")]

    with implementer_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert len(turned.messages) == 2, "one extra message, not more"
        assert [c.subject for c in result.commits] == [LEFTOVER_MESSAGE]
        assert result.pushed and turned.origin_tip() == result.head_commit
        author = raw(
            "log", "-1", "--format=%an <%ae>|%cn <%ce>", result.head_commit or "",
            cwd=turned.workspace.mirror, git=turned.rig.git,
        )  # fmt: skip
        identity = turned.workspace.identity
        assert author == f"{identity.name} <{identity.email}>|{identity.name} <{identity.email}>"


# #764-T08
def test_a_model_that_ends_without_tools_and_without_a_commit_gave_up_with_its_text(
    tmp_path: Path,
) -> None:
    with implementer_turn(tmp_path, lambda repo: [says("There is nothing I can do here.")]) as t:
        result = t.result

        assert result.error_code is ErrorCode.AGENT_GAVE_UP
        assert result.summary == "There is nothing I can do here."
        assert result.commits == () and result.head_commit is None and not result.pushed
        assert t.origin_tip() is None, "no ref is created on the remote"
        assert len(t.messages) == 1


# #764-T06
def test_the_cost_limit_ends_the_turn_and_the_leftover_is_committed_and_pushed(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, f"f{number}.txt") for number in range(40)]

    with implementer_turn(tmp_path, script, limit="0.05") as turned:
        result = turned.result
        calls_at_refusal = len(turned.upstream.records)

        assert result.error_code is ErrorCode.COST_LIMIT_REACHED, result.notes
        assert result.files_changed, "what the agent wrote before the limit is kept"
        assert [c.subject for c in result.commits] == [LEFTOVER_MESSAGE]
        assert result.pushed and turned.origin_tip() == result.head_commit
        assert len(turned.messages) == 1, "no extra message after a limit"
        assert len(turned.requests) < 40
        assert calls_at_refusal == len(turned.upstream.records), "no model call after the end"
        assert result.usage.cost_usd is not None and result.usage.cost_usd > 0


# #764-T07
def test_the_time_limit_stops_the_agent_and_the_leftover_is_committed_and_pushed(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [write_file(repo, f"f{number}.txt") for number in range(40)]

    def react(turned: Turned, scene: Scene, body: dict[str, Any]) -> None:
        if scene.calls == 3:
            scene.clock_offset = 10_000.0  # far past the limit of the job

    with implementer_turn(tmp_path, script, time_limit=3600, react=react) as turned:
        result = turned.result

        assert result.error_code is ErrorCode.TIME_LIMIT_REACHED, result.notes
        assert [c.subject for c in result.commits] == [LEFTOVER_MESSAGE]
        assert result.pushed and turned.origin_tip() == result.head_commit
        assert len(turned.requests) < 40


def tool_names_of(body: dict[str, Any]) -> set[str]:
    return {tool["name"] for tool in body["tools"]}


# #764-T12
def test_an_engine_killed_in_the_middle_of_a_turn_is_a_runner_error_and_the_partial_work_is_pushed(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "one.txt"),
            commit("Add one"),
            write_file(repo, "two.txt"),
            commit("Add two"),
            says("done"),
        ]

    def react(turned: Turned, scene: Scene, body: dict[str, Any]) -> None:
        if scene.calls == 4:  # one.txt is committed, two.txt is being written
            turned.kill_engine()

    with implementer_turn(tmp_path, script, react=react) as turned:
        result = turned.result

        assert result.error_code is ErrorCode.RUNNER_ERROR, (result.error_detail, result.notes)
        assert "Add one" in [c.subject for c in result.commits]
        assert result.pushed and turned.origin_tip() == result.head_commit
        for process in turned.processes:
            assert process.poll() is not None, "no engine process is left"


# #764-T14
def test_a_call_of_a_tool_that_is_denied_is_refused_and_the_turn_goes_on(tmp_path: Path) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            Turn(tool="webfetch", args={"url": "https://example.com", "format": "text"}),
            Turn(tool="websearch", args={"query": "anything"}),
            Turn(tool="question", args={"questions": []}),
            Turn(tool="task", args={"description": "x", "prompt": "y", "subagent_type": "general"}),
            says("I could not use those tools."),
        ]

    with implementer_turn(tmp_path, script) as turned:
        offered = tool_names_of(turned.requests[0])
        assert offered >= {"read", "write", "edit", "bash", "grep", "glob"}
        assert not offered & {"webfetch", "websearch", "question", "task", "skill"}
        assert len(turned.requests) == 5, "every denied call was answered and the turn went on"
        assert turned.result.error_code is ErrorCode.AGENT_GAVE_UP
        assert turned.result.summary == "I could not use those tools."
        for record in turned.upstream.records:
            assert "example.com" not in json.dumps(record.headers)


# #764-T02
def test_the_environment_of_the_spawned_engine_holds_no_secret_and_only_the_named_variables(
    tmp_path: Path,
) -> None:
    with implementer_turn(
        tmp_path, lambda repo: [write_file(repo, "a.txt"), commit("a"), says("ok")]
    ) as turned:
        (environment,) = turned.spawned
        text = json.dumps(environment)

        assert TOKEN not in text and REAL_KEY not in text, "no git token, no provider key"
        config = json.loads(turned.config_texts[0])
        capability = config["provider"]["anthropic"]["options"]["apiKey"]
        assert capability not in text, "the capability is in the config file and nowhere else"
        assert not {name for name in environment if "KEY" in name or "TOKEN" in name}
        assert environment["OPENCODE_CONFIG"].endswith("opencode.json")
        assert environment["GIT_CONFIG_SYSTEM"] == str(turned.workspace.system_config_path)
        assert environment["GIT_AUTHOR_NAME"] == turned.workspace.identity.name
        ripgrep = ripgrep_binary()
        assert ripgrep is not None
        assert environment["PATH"].split(":")[0] == str(ripgrep.parent)
        assert "HTTPS_PROXY" not in environment, "network none sets nothing"


# #764-T04
def test_the_instruction_is_the_user_message_and_nowhere_in_the_system_part(
    tmp_path: Path,
) -> None:
    secret_instruction = "Rename the function SENTINEL_INSTRUCTION_7 to fetch."
    with implementer_turn(
        tmp_path, lambda repo: [says("nothing to do")], instruction=secret_instruction
    ) as turned:
        assert turned.messages[0][1] == secret_instruction
        request = turned.requests[0]
        system = json.dumps(request["system"])
        assert "SENTINEL_INSTRUCTION_7" not in system
        assert "SENTINEL_INSTRUCTION_7" in json.dumps(request["messages"])
        assert "SENTINEL_INSTRUCTION_7" not in turned.config_texts[0]
        assert SYSTEM_PROMPT.splitlines()[0] in system, "the runner's prompt is the system part"


def marked_blocks(body: dict[str, Any]) -> int:
    """How many blocks of a Messages request carry a `cache_control` mark."""
    count = sum(1 for block in body.get("system", []) if "cache_control" in block)
    for message in body["messages"]:
        content: Any = message["content"]
        if isinstance(content, list):
            blocks = cast("list[dict[str, Any]]", content)
            count += sum(1 for block in blocks if "cache_control" in block)
    return count


# #764-T09
def test_prompt_caching_stays_on_the_marks_reach_the_provider_and_the_ledger_counts_the_cache(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "a.txt"),
            bash("cat a.txt"),
            commit("Add a"),
            says("done"),
        ]

    with implementer_turn(tmp_path, script) as turned:
        result = turned.result
        assert result.ok, (result.error_code, result.error_detail)
        bodies = turned.requests
        assert len(bodies) == 4

        # The marks the stock engine puts on a Claude request reach the provider as it wrote them,
        # on every call: nothing of the runner removes them (and the runner adds none).
        for body in bodies:
            assert marked_blocks(body) >= 1
            assert not any("cache_control" in tool for tool in body["tools"])
        # Replayed through the cache rules of the docs (the fake of `fakes/llm`), the run reads its
        # own earlier prefix from the second call on, and no request is rejected.
        cache = PromptCache()
        usages = [
            cache.usage(body, real_anthropic_usage(output_tokens=10), minimum=256)
            for body in bodies
        ]
        assert usages[0]["cache_read_input_tokens"] == 0
        assert usages[0]["cache_creation_input_tokens"] > 0
        reads = [usage["cache_read_input_tokens"] for usage in usages]
        assert all(later > 0 for later in reads[1:]) and reads == sorted(reads)

        # The ledger counts what the provider stated, cache reads and writes included, and prices
        # it with the book: the independent calculator agrees to the last digit.
        total = Fraction(0)
        prompt = 0
        tool_calls = 0
        for position, record in enumerate(turned.upstream.records, start=1):
            has_tools = turned.carries_tools(record.body)
            if has_tools:
                tool_calls += 1
            stated = usage_expected(
                tool_calls if has_tools else 100 + position, WireFamily.ANTHROPIC_MESSAGES
            )
            prompt += stated.prompt_tokens
            cost = expected_cost(
                BOOK,
                prompt=stated.prompt_tokens,
                completion=stated.completion_tokens,
                read=stated.cache_read,
                write_5m=stated.cache_write_5m,
                write_1h=stated.cache_write_1h,
            )
            assert cost is not None
            total += cost
        assert result.usage.ai_calls == len(turned.upstream.records)
        assert result.usage.prompt_tokens == prompt
        assert result.usage.cost_usd == pytest.approx(float(total), rel=1e-9)
