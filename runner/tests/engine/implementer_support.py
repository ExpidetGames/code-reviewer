# SPDX-License-Identifier: LicenseRef-Proprietary

"""A whole Implementer turn (#764) against the real, pinned OpenCode. Not a test file.

`ImplementerSession` runs unchanged: the production ledger and passthrough proxy (the key swapping
last hop is a loopback double), the generated engine configuration and environment, the push loop and
the git workspace of #762 over a bare repository on the file system standing in for GitHub. The only
scripted part is the model: the strict generic fake of `fakes/wire` plays one tool call or one text
per request. Nothing here talks beyond loopback, and the tests run as an ordinary user (the user
separation is proven by the privileged lane).
"""

import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Generator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integration"))

from fakes.wire.formats import Family, Turn, UsageFault
from fakes.wire.upstream import Refusal, ScriptedUpstream
from native_full_job import ENTRIES, MANAGED
from opencode_native import BASE_PATH, REAL_KEY
from opencode_support import opencode_binary, ripgrep_binary
from passthrough_loopback import LoopbackUpstream
from plain_final_support import OUTPUT_LIMIT, Reaction, Scene
from workspace_support import BRANCH, Rig

from code_reviewer_runner.dynamic_review.adapter import _http_request  # pyright: ignore[reportPrivateUsage]
from code_reviewer_runner.dynamic_review.static_isolation import ImplementerNetwork
from code_reviewer_runner.implementer.egress_config import EgressSettings
from code_reviewer_runner.implementer.git_workspace import GitWorkspace
from code_reviewer_runner.implementer.session import ImplementerSession, SessionSeams
from code_reviewer_runner.implementer.turn_result import TurnResult
from code_reviewer_runner.job import ImplementerInput, parse_implementer_input
from git_support import TOKEN, Origin, guard_git

EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
INSTRUCTION = "Add a greeting file and commit it."


def implementer_job(
    family: Family,
    cost: Mapping[str, Any] = MANAGED,
    *,
    time_limit: int = 3600,
    max_cost_usd: float | None = None,
    instruction: str = INSTRUCTION,
) -> ImplementerInput:
    """The contract's example job with the provider, model and cost policy of the test."""
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    entry = ENTRIES[family]
    spec = document["implementer"]
    spec["instruction"] = instruction
    spec["limits"]["timeLimitSeconds"] = time_limit
    spec["cost"] = dict(cost)
    model_entry = spec["modelEntry"]
    model_entry.update(
        providerId=entry["provider"],
        npm=entry["npm"],
        family=entry["family"],
        authHeader=entry["authHeader"],
        upstreamBaseUrl=entry["upstreamBaseUrl"],
        modelId=entry["model"],
    )
    model_entry["model"]["limit"] = {"context": 1_000_000, "output": OUTPUT_LIMIT}
    model_entry["model"]["reasoning"] = False
    model_entry["model"].pop("interleaved", None)
    document["git"]["token"] = TOKEN
    document["llm"] = {
        "provider": entry["provider"],
        "model": entry["model"],
        "apiKey": REAL_KEY,
        **({} if max_cost_usd is None else {"maxCostUsd": max_cost_usd}),
    }
    return parse_implementer_input(json.dumps(document))


@dataclass
class Turned:
    upstream: ScriptedUpstream
    rig: Rig
    workspace: GitWorkspace
    scene: Scene
    # Set when the turn has ended (a `react` runs before that and must not read it).
    result: TurnResult = field(init=False)
    # The messages the runner sent the engine: (session id, text of the one text part).
    messages: list[tuple[str, str]] = field(default_factory=lambda: [])
    # The environment the engine was started with, and its process (for a test that kills it).
    spawned: list[dict[str, str]] = field(default_factory=lambda: [])
    processes: list[subprocess.Popen[bytes]] = field(default_factory=lambda: [])
    config_texts: list[str] = field(default_factory=lambda: [])

    @property
    def requests(self) -> list[dict[str, Any]]:
        """The bodies of the model calls that offered tools: the ones the script answered."""
        bodies: list[dict[str, Any]] = []
        for record in self.upstream.records:
            body: Any = record.body
            if isinstance(body, dict) and body.get("tools"):  # pyright: ignore[reportUnknownMemberType]
                bodies.append(dict(body))  # pyright: ignore[reportUnknownArgumentType]
        return bodies

    def origin_tip(self) -> str | None:
        return self.rig.origin.tip(BRANCH)

    def kill_engine(self) -> None:
        for process in self.processes:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


@contextmanager
def implementer_turn(
    scratch: Path,
    script: Callable[[Path], list[Turn]],
    *,
    family: Family = "messages",
    cost: Mapping[str, Any] = MANAGED,
    limit: str = "5.00",
    max_cost_usd: float | None = None,
    time_limit: int = 3600,
    react: Callable[[Turned, Scene, dict[str, Any]], None] | None = None,
    usage_fault: UsageFault | None = None,
    instruction: str = INSTRUCTION,
    tick: float = 0.3,
) -> Generator[Turned]:
    """Run one whole turn to its result against a model that follows `script(repo)`.

    `react(turned, scene, body)` runs on every model call that offers tools, before it is answered:
    a test advances the clock (`scene.clock_offset`) or kills the engine there."""
    git = guard_git()
    rig = Rig(scratch, git, Origin(scratch, git))
    workspace = rig.prepared()
    scene = Scene()
    job = implementer_job(
        family, cost, time_limit=time_limit, max_cost_usd=max_cost_usd, instruction=instruction
    )
    ripgrep = ripgrep_binary()
    assert ripgrep is not None, "the engine tests need an rg on the PATH (OPENCODE_TEST_PATH)"
    turned: Turned | None = None  # made below, before the session runs

    def judge(headers: Mapping[str, str], body: Mapping[str, Any]) -> Refusal | None:
        if body.get("tools"):
            scene.calls += 1
            if react is not None and turned is not None:
                react(turned, scene, dict(body))
        return None

    messages: list[tuple[str, str]] = []

    def transport(
        method: str, url: str, body: bytes | None, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, bytes]:
        if method == "POST" and body is not None and url.endswith("/message"):
            document = json.loads(body)
            session = url.rsplit("/session/", 1)[1].split("/", 1)[0]
            messages.append((session, document["parts"][0]["text"]))
        return _http_request(method, url, body, headers, timeout)

    spawned: list[dict[str, str]] = []
    processes: list[subprocess.Popen[bytes]] = []
    config_texts: list[str] = []

    def popen(argv: list[str], **options: Any) -> subprocess.Popen[bytes]:
        environment: dict[str, str] = dict(options["env"])
        spawned.append(environment)
        config_texts.append(Path(environment["OPENCODE_CONFIG"]).read_text(encoding="utf-8"))
        process = subprocess.Popen(argv, **options)
        processes.append(process)
        return process

    with ExitStack() as stack:
        upstream = stack.enter_context(
            ScriptedUpstream(
                family,
                script(workspace.repo),
                ENTRIES[family]["model"],
                real_key=REAL_KEY,
                judge=judge,
            )
        )
        upstream.usage_fault = usage_fault
        scene.upstream = upstream
        hop = LoopbackUpstream(upstream.url + BASE_PATH[family])
        session = ImplementerSession(
            job,
            workspace=workspace,
            command=[str(opencode_binary())],
            egress=EgressSettings(ImplementerNetwork.NONE, None),
            environment={"RUNNER_DYNAMIC_MAX_COST_USD": limit},
            ripgrep=ripgrep,
            seams=SessionSeams(
                upstream_for=lambda _url: hop,
                popen=popen,
                transport=transport,
                tick_seconds=tick,
                startup_seconds=60.0,
                scratch_dir=str(scratch / "engine"),
                clock=lambda: time.monotonic() + scene.clock_offset,
            ),
        )
        turned = Turned(
            upstream=upstream,
            rig=rig,
            workspace=workspace,
            scene=scene,
            messages=messages,
            spawned=spawned,
            processes=processes,
            config_texts=config_texts,
        )
        turned.result = session.run()
        yield turned
        for process in processes:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


# -- the turns a script is made of ---------------------------------------------------------------


def write_file(repo: Path, name: str, content: str = "hello\n") -> Turn:
    return Turn(tool="write", args={"filePath": str(repo / name), "content": content})


def bash(command: str) -> Turn:
    return Turn(tool="bash", args={"command": command, "description": "run a command"})


def commit(message: str = "Add a greeting") -> Turn:
    return bash(f"git add -A && git commit -qm '{message}'")


def says(text: str) -> Turn:
    return Turn(text=text)


__all__ = [
    "BRANCH",
    "INSTRUCTION",
    "Reaction",
    "Turned",
    "bash",
    "commit",
    "implementer_job",
    "implementer_turn",
    "says",
    "write_file",
]
