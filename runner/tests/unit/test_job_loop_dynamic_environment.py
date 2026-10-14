# SPDX-License-Identifier: Apache-2.0

"""What the job loop hands to a Dynamic job process, and to nobody else (#202).

The job process of a Dynamic job is the root supervisor, and its environment is an allow-list built
by the loop. After the startup self-check the loop adds the verified engine command, the engines it
advertised and the operator's description of the model; a Diff job process gets none of it, and a
loop whose check failed hands over no engine at all.
"""

import json

from loop_support import RUNNER_TOKEN, Harness, make_claim, run
from test_dynamic_review_run import dynamic_document

from code_reviewer_runner.capabilities import (
    ALL_ENGINES,
    ENGINE_DIFF,
    ENGINES_VARIABLE,
    RIPGREP_PATH_VARIABLE,
)

COMMAND_VARIABLE = "RUNNER_OPENCODE_COMMAND"
OPERATOR = {
    "RUNNER_DYNAMIC_CAPABILITIES": '{"tool_choice_required": true}',
    "RUNNER_DYNAMIC_ENGINE_UID": "10101",
    "RUNNER_DYNAMIC_ENGINE_GID": "10101",
    "RUNNER_DYNAMIC_PROXY_PORT": "10180",
    "RUNNER_DYNAMIC_ENGINE_PORT": "10181",
    # #290-T11: the operator cost limit reaches the Dynamic job process, and only that one.
    "RUNNER_DYNAMIC_MAX_COST_USD": "2.5",
}
USERS = {"diff_job_user": (10001, 10001), "dynamic_engine_user": (10101, 10101)}


# #202-T01
def test_a_dynamic_job_process_gets_the_verified_engine_and_the_model_description() -> None:
    async def scenario() -> None:
        harness = Harness(
            **USERS,
            engines=ALL_ENGINES,
            dynamic_command=("/usr/local/bin/opencode",),
            dynamic_ripgrep="/usr/local/bin/rg",
            environment={
                **OPERATOR,
                "RUNNER_OPENCODE_COMMAND": "/tmp/operator-chosen",
                "RUNNER_DYNAMIC_RIPGREP": "/tmp/operator-chosen-rg",
            },
        )
        harness.api.claims = [make_claim(1, **dynamic_document())]
        await harness.start()

        env = harness.launcher.processes[0].spec.env
        assert env[ENGINES_VARIABLE] == "pr-agent,opencode"
        # The command is the one the self-check verified, never an operator-supplied one.
        assert env[COMMAND_VARIABLE] == "/usr/local/bin/opencode"
        # So is `rg`: the verified file, never the operator's.
        assert env[RIPGREP_PATH_VARIABLE] == "/usr/local/bin/rg"
        for name, value in OPERATOR.items():
            assert env[name] == value
        assert RUNNER_TOKEN not in json.dumps(dict(env))
        await harness.stop()

    run(scenario)


# #202-T09: a runner whose check failed hands no engine to a Dynamic job it somehow received.
def test_a_dynamic_job_process_of_a_runner_without_the_capability_gets_no_engine() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS, engines=(ENGINE_DIFF,), environment=OPERATOR)
        harness.api.claims = [make_claim(1, **dynamic_document())]
        await harness.start()

        env = harness.launcher.processes[0].spec.env
        assert env[ENGINES_VARIABLE] == "pr-agent"
        assert COMMAND_VARIABLE not in env and RIPGREP_PATH_VARIABLE not in env
        await harness.stop()

    run(scenario)


# #202-T03: a Diff job process is the PR-Agent process it always was.
def test_a_diff_job_process_gets_no_dynamic_variable() -> None:
    async def scenario() -> None:
        harness = Harness(
            **USERS,
            engines=ALL_ENGINES,
            dynamic_command=("/usr/local/bin/opencode",),
            dynamic_ripgrep="/usr/local/bin/rg",
            environment=OPERATOR,
        )
        harness.api.claims = [make_claim(1)]
        await harness.start()

        env = harness.launcher.processes[0].spec.env
        assert not [
            name
            for name in env
            if name.startswith("RUNNER_") and name != "RUNNER_JOB_TIMEOUT_SECONDS"
        ]
        assert ENGINES_VARIABLE not in env and COMMAND_VARIABLE not in env
        assert RIPGREP_PATH_VARIABLE not in env
        await harness.stop()

    run(scenario)
