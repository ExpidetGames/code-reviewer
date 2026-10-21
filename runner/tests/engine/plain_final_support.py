# SPDX-License-Identifier: Apache-2.0

"""The production adapter on the native path against the real pinned OpenCode (#552).

`DynamicEngine(plain_final=True)` runs the real engine with the trusted native configuration
(`build_native_engine_config`) behind the production `PassthroughProxy` and ledger, with the strict
generic fake of `fakes/wire` as the provider: the adapter, the finalization, the audit on the
engine's event stream and the ledger are all production code; only the last hop is a double.
Nothing here talks beyond loopback. Not a test file.
"""

import sys
import time
from collections.abc import Callable, Generator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Family, Turn
from fakes.wire.upstream import Record, Refusal, ScriptedUpstream
from opencode_native import (
    BASE_PATH,
    DEFAULT_IDS,
    REAL_KEY,
    Provider,
    make_export,
    provider_block,
    tool_script,
)
from opencode_passthrough import PRICES, WIRE
from opencode_support import dynamic_job, extra_path, findings_for, opencode_binary, ripgrep_binary

from code_reviewer_runner.dynamic_review import findings_schema
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine, EngineAnswer
from code_reviewer_runner.dynamic_review.budget import BudgetLedger, DynamicLimits
from code_reviewer_runner.dynamic_review.config import (
    build_native_engine_config,
    new_proxy_capability,
)
from code_reviewer_runner.dynamic_review.passthrough.admission import (
    PassthroughTarget,
    output_allowance,
)
from code_reviewer_runner.dynamic_review.passthrough.cost_policy import CostPolicy
from code_reviewer_runner.dynamic_review.passthrough.native_run import build_native_run
from code_reviewer_runner.dynamic_review.passthrough.proxy import PassthroughProxy
from code_reviewer_runner.dynamic_review.passthrough.server import PassthroughServer
from code_reviewer_runner.dynamic_review.prompts import ReviewInputs
from passthrough_loopback import LoopbackUpstream

HEAD = "1f3a5c7e9b2d4f60a8c1e3b5d7f90a2c4e6b8d01"
EXPORTED = frozenset({"src/app.py", "src/db.py", "README.md"})
OUTPUT_LIMIT = 8192


def reads(export: Path, count: int) -> list[Turn]:
    """`count` tool calls over the little export (glob, read, grep, ...)."""
    return tool_script(export, count)[:count]


def review(count: int = 1) -> str:
    """The review a model writes under the core prompt: no `schemaVersion`, no `reviewedSha`."""
    import json

    document = findings_for(HEAD)
    finding = document["findings"][0]
    document["findings"] = [{**finding, "id": f"f-{index}"} for index in range(count)]
    del document["schemaVersion"], document["reviewedSha"]
    for entry in document["findings"]:
        del entry["reviewedSha"]
    return json.dumps(document)


class Scene:
    """What a test can do to the provider while the run goes on: see each request that carries
    tools, and decide what the provider's next answer is (a test that must not depend on how many
    calls the cost limit admits before it refuses)."""

    def __init__(self) -> None:
        self.upstream: ScriptedUpstream | None = None
        self.ledger: BudgetLedger | None = None
        self.calls = 0
        # Seconds the run's clock is ahead of the real one (a test moves it to reach a deadline).
        self.clock_offset = 0.0

    def wait_until(self, condition: Callable[[], bool], seconds: float = 10.0) -> None:
        """Hold the provider's answer until `condition` holds (the run goes on beside it)."""
        until = time.monotonic() + seconds
        while not condition() and time.monotonic() < until:
            time.sleep(0.02)

    def answer_next_with(self, turn: Turn) -> None:
        """The next call the provider answers is `turn`, whatever the script said."""
        assert self.upstream is not None
        script = self.upstream._script  # pyright: ignore[reportPrivateUsage]
        served = self.upstream._served  # pyright: ignore[reportPrivateUsage]
        script[served] = turn


Reaction = Callable[[Scene, dict[str, Any]], None]


@dataclass
class NativeRun:
    answer: EngineAnswer
    ledger: BudgetLedger
    proxy: PassthroughProxy
    upstream: ScriptedUpstream
    engine: DynamicEngine

    @property
    def requests(self) -> list[dict[str, Any]]:
        """The bodies of the calls that carried tools: the ones the model answered (a title call
        has none)."""
        bodies: list[dict[str, Any]] = []
        for record in self.upstream.records:
            body: Any = record.body
            if isinstance(body, dict):
                document = cast("dict[str, Any]", body)
                if document.get("tools"):
                    bodies.append(document)
        return bodies

    @property
    def records(self) -> list[Record]:
        return self.upstream.records


def tool_names(request: dict[str, Any]) -> set[str]:
    return {tool["name"] for tool in request.get("tools", [])}


def user_texts(request: dict[str, Any]) -> list[str]:
    """The texts of the user messages of a Messages request, in order."""
    texts: list[str] = []
    for message in request["messages"]:
        if message["role"] != "user":
            continue
        content = message["content"]
        if isinstance(content, str):
            texts.append(content)
            continue
        texts += [block["text"] for block in content if block.get("type") == "text"]
    return texts


@contextmanager
def native_run(
    scratch: Path,
    script: Callable[[Path], list[Turn]],
    *,
    limit: str = "5.00",
    family: Family = "messages",
    react: Reaction | None = None,
    policy: CostPolicy | None = None,
) -> Generator[NativeRun]:
    """Run one review on the native path against a provider that follows `script(export)`."""
    export = make_export(scratch)
    provider = Provider(family)
    scene = Scene()

    def judge(headers: Mapping[str, str], body: Mapping[str, Any]) -> Refusal | None:
        if react is not None and body.get("tools"):
            scene.calls += 1
            react(scene, dict(body))
        return None

    with ExitStack() as stack:
        upstream = stack.enter_context(
            ScriptedUpstream(
                family, script(export), provider.model_id, real_key=REAL_KEY, judge=judge
            )
        )
        scene.upstream = upstream
        capability = new_proxy_capability()
        limits = DynamicLimits(max_cost_usd=Decimal(limit))
        target = PassthroughTarget(
            family=WIRE[family],
            model=provider.model_id,
            output_allowance=output_allowance(OUTPUT_LIMIT),
        )
        hop = LoopbackUpstream(upstream.url + BASE_PATH[family])
        if policy is None:
            ledger = BudgetLedger(
                limits,
                window_tokens=1_000_000,
                output_tokens=output_allowance(OUTPUT_LIMIT),
                unit_costs=PRICES,
                clock=lambda: time.monotonic() + scene.clock_offset,
            )
            proxy = PassthroughProxy(
                ledger=ledger,
                target=target,
                upstream=hop,
                upstream_api_key=REAL_KEY,
                capability=capability,
                prices=PRICES,
            )
        else:
            # A native job under its cost policy (#553): the ledger and the proxy of one policy.
            made = build_native_run(
                policy,
                limits,
                window_tokens=1_000_000,
                output_tokens=output_allowance(OUTPUT_LIMIT),
                target=target,
                upstream=hop,
                upstream_api_key=REAL_KEY,
                capability=capability,
                clock=lambda: time.monotonic() + scene.clock_offset,
            )
            ledger, proxy = made.ledger, made.proxy
        scene.ledger = ledger
        server = PassthroughServer(proxy, "127.0.0.1", 0).start()
        stack.callback(server.stop)
        block = provider_block(provider, server.url)
        block["options"]["apiKey"] = capability
        reference = f"{provider.provider_id}/{provider.model_id}"
        config = build_native_engine_config(
            provider={provider.provider_id: block},
            model_reference=reference,
            system_prompt="You review code. Use read, grep and glob, then answer in JSON text.",
            family=WIRE[family],
            proxy_url=server.url,
            capability=capability,
        )
        job = dynamic_job(HEAD, provider.model_id)
        engine = DynamicEngine(
            job,
            ledger=ledger,
            command=[str(opencode_binary())],
            directory=str(export),
            proxy_url=server.url,
            proxy_capability=capability,
            agent_prompt="unused: the native config carries the prompt",
            model_schema=findings_schema(),
            inputs=ReviewInputs(
                pr_url=job.pr_url, pr_title="Add a handler", pr_body="Please review.", diff=""
            ),
            exported_paths=EXPORTED,
            scratch_dir=str(scratch / "engine"),
            node_bin=extra_path(),
            ripgrep=ripgrep_binary(),
            startup_seconds=60.0,
            plain_final=True,
            engine_config=config,
            provider_id=provider.provider_id,
            provider_error=lambda: proxy.last_upstream_error,
            wait_idle=proxy.wait_idle,
        )
        answer = engine.run()
        yield NativeRun(answer, ledger, proxy, upstream, engine)


__all__ = ["DEFAULT_IDS", "native_run", "reads", "review"]
