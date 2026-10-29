# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down that the engine suite never leaves the machine: every connection of a job process goes
to loopback (the process records its connections and refuses all others, see connect_guard/), the
caches PR-Agent needs are on disk, and a job that points the LLM key at a foreign host is refused
before PR-Agent starts."""

import os
import subprocess
import sys
from pathlib import Path

import pytest
from fake_github import FakeGithub
from fake_llm import FakeLlm
from harness import GUARD, Engine


def hosts_of(connections: list[dict[str, object]]) -> set[str]:
    return {str(connection["target"]).rsplit(":", 1)[0] for connection in connections}


# CR-41-T14, #203
@pytest.mark.parametrize("command", [pytest.param("review", marks=pytest.mark.smoke)])
def test_every_connection_of_a_run_goes_to_loopback_and_only_to_the_two_fakes(
    engine: Engine, github: FakeGithub, llm: FakeLlm, command: str
) -> None:
    outcome = engine.run(command)

    assert outcome.returncode == 0
    assert outcome.result["ok"] is True
    assert outcome.connections != []
    assert all(connection["allowed"] for connection in outcome.connections)
    assert {connection["kind"] for connection in outcome.connections} == {"connect"}
    assert hosts_of(outcome.connections) == {"127.0.0.1"}
    ports = {int(str(connection["target"]).rsplit(":", 1)[1]) for connection in outcome.connections}
    assert ports == {github.port, llm.port}


# CR-41-T14
@pytest.mark.parametrize(
    "foreign",
    ["https://openrouter.example.com/api/v1", "http://10.0.0.5:8080/api/v1", "http://[::2]/api/v1"],
)
def test_a_job_that_sends_the_llm_key_to_a_foreign_host_is_refused_before_pr_agent_starts(
    engine: Engine, github: FakeGithub, llm: FakeLlm, foreign: str
) -> None:
    job = engine.job("review")
    job["llm"]["baseUrl"] = foreign

    outcome = engine.run(job=job)

    assert outcome.returncode != 0
    assert outcome.result["ok"] is False
    assert outcome.result["errorCode"] == "invalid_job"
    assert outcome.result["commentUrl"] is None
    assert outcome.connections == []
    assert github.requests == []
    assert llm.requests == []


# CR-41-T14 (the guard itself works, so the claims above are not empty)
@pytest.mark.parametrize(
    "attempt",
    [
        "socket.create_connection(('203.0.113.7', 80), timeout=1)",
        "socket.getaddrinfo('example.invalid', 80)",
        "socket.gethostbyname('example.invalid')",
        "socket.gethostbyname_ex('example.invalid')",
        "socket.gethostbyaddr('203.0.113.7')",
        "socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'x', ('203.0.113.7', 53))",
    ],
)
def test_the_connection_guard_records_and_refuses_a_foreign_host(
    tmp_path: Path, attempt: str
) -> None:
    log = tmp_path / "connections.jsonl"
    environment = {**os.environ, "PYTHONPATH": str(GUARD), "ENGINE_CONNECT_LOG": str(log)}
    code = f"import socket\ntry:\n    {attempt}\nexcept OSError as error:\n    print(error)\n"

    done = subprocess.run(
        [sys.executable, "-c", code], env=environment, capture_output=True, text=True, check=False
    )

    assert "only loopback is reachable" in done.stdout
    assert '"allowed": false' in log.read_text()
