# SPDX-License-Identifier: Apache-2.0

"""A whole native Dynamic job (#578) against the real pinned OpenCode: `run_dynamic_job` with the
claim of a native job, the production passthrough proxy, ledger, engine configuration and
finalization, and the strict generic fake of `fakes/wire` as the provider. The preparation, the
publication and the last hop to the provider are the only doubles (`LoopbackUpstream` stands for the
pinned https connection). Nothing here talks beyond loopback. Not a test file.
"""

import json
import sys
from collections.abc import Callable, Generator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Family, Turn
from fakes.wire.upstream import Record, Refusal, ScriptedUpstream
from opencode_native import BASE_PATH, REAL_KEY, make_export
from opencode_support import extra_path, opencode_binary, ripgrep_binary
from plain_final_support import EXPORTED, HEAD, OUTPUT_LIMIT, Reaction, Scene

from code_reviewer_runner import runner
from code_reviewer_runner.capabilities import ALL_ENGINES
from code_reviewer_runner.dynamic_findings import DynamicFindings
from code_reviewer_runner.dynamic_review.adapter import DynamicEngine
from code_reviewer_runner.dynamic_review.checkout import PreparedContent
from code_reviewer_runner.dynamic_review.limits import CheckoutMetrics
from code_reviewer_runner.dynamic_review.native_job import NativeSeams
from code_reviewer_runner.dynamic_review.publish import Published
from code_reviewer_runner.job import Job, parse_job
from code_reviewer_runner.result import JobResult
from passthrough_loopback import LoopbackUpstream

BOOK: dict[str, Any] = {
    "input": "3000000",
    "output": "15000000",
    "cacheRead": "300000",
    "cacheWrite5m": "3750000",
    "cacheWrite1h": "6000000",
    "reasoning": None,
    "inputAudio": None,
    "outputAudio": None,
    "contextOver200k": None,
    "tiers": [],
}
MANAGED = {"keyMode": "managed", "priceBook": BOOK, "maxTotalTokens": None}
OWN = {"keyMode": "own", "priceBook": None, "maxTotalTokens": 4_000_000}
# The registry provider the key belongs to, and the entry of the family the fake speaks.
ENTRIES: dict[Family, dict[str, Any]] = {
    "messages": {
        "provider": "anthropic",
        "npm": "@ai-sdk/anthropic",
        "family": "anthropic-messages",
        "authHeader": "x-api-key",
        "upstreamBaseUrl": "https://api.anthropic.com/v1",
        "model": "acme-claude-9",
    },
    "chat": {
        "provider": "openrouter",
        "npm": "@ai-sdk/openai-compatible",
        "family": "openai-chat",
        "authHeader": "Authorization",
        "upstreamBaseUrl": "https://openrouter.ai/api/v1",
        "model": "acme-chat-9",
    },
}


def job_for(family: Family, cost: Mapping[str, Any]) -> Job:
    entry = ENTRIES[family]
    model = entry["model"]
    return parse_job(
        json.dumps(
            {
                "prUrl": "https://github.com/octo/repo/pull/196",
                "command": "review",
                "reviewKind": "dynamic",
                "dynamic": {
                    "model": model,
                    "skill": "SKILL_TEXT_FROM_THE_PROJECT: look for real bugs.",
                    "limits": {"maxFindings": 5},
                    "cost": dict(cost),
                    "modelEntry": {
                        "version": 1,
                        "providerId": entry["provider"],
                        "npm": entry["npm"],
                        "family": entry["family"],
                        "authHeader": entry["authHeader"],
                        "upstreamBaseUrl": entry["upstreamBaseUrl"],
                        "modelId": model,
                        "model": {
                            "name": "Acme model",
                            "status": "active",
                            "tool_call": True,
                            "reasoning": False,
                            "temperature": True,
                            "limit": {"context": 1_000_000, "output": OUTPUT_LIMIT},
                            "modalities": {"input": ["text"], "output": ["text"]},
                        },
                    },
                },
                "base": {
                    "repository": "octo/repo",
                    "baseRef": "main",
                    "headSha": HEAD,
                    "previousReviewedSha": None,
                    "comparison": "full",
                },
                "git": {
                    "provider": "github",
                    "baseUrl": "https://api.github.com",
                    "token": "dummy-installation-token-0123456789",
                    "botLogin": "code-reviewer[bot]",
                },
                "llm": {"provider": entry["provider"], "model": model, "apiKey": REAL_KEY},
            }
        )
    )


class Publisher:
    URL = "https://github.com/octo/repo/pull/196#issuecomment-1"

    def __init__(self) -> None:
        self.calls: list[DynamicFindings] = []

    def __call__(
        self, job: Job, found: DynamicFindings, may_write: Callable[[], bool] | None = None
    ) -> Published:
        self.calls.append(found)
        return Published(comment_url=self.URL, created=True)


@dataclass
class FullJob:
    result: JobResult
    publisher: Publisher
    upstream: ScriptedUpstream
    family: Family = "messages"
    # The configuration the engine was given, as the adapter received it.
    configs: list[dict[str, Any]] = field(default_factory=lambda: [])

    @property
    def requests(self) -> list[dict[str, Any]]:
        """The bodies of the calls that carried tools: the ones the model answered."""
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


@contextmanager
def full_job(
    scratch: Path,
    script: Callable[[Path], list[Turn]],
    *,
    family: Family = "messages",
    cost: Mapping[str, Any] = MANAGED,
    limit: str = "5.00",
    react: Reaction | None = None,
) -> Generator[FullJob]:
    """Run one whole native job to its result."""
    export = make_export(scratch)
    entry = ENTRIES[family]
    scene = Scene()

    def judge(headers: Mapping[str, str], body: Mapping[str, Any]) -> Refusal | None:
        if react is not None and body.get("tools"):
            scene.calls += 1
            react(scene, dict(body))
        return None

    publisher = Publisher()
    configs: list[dict[str, Any]] = []

    def engine(job: Job, **options: Any) -> DynamicEngine:
        configs.append(options["engine_config"])
        return DynamicEngine(job, startup_seconds=60.0, **options)

    with ExitStack() as stack:
        upstream = stack.enter_context(
            ScriptedUpstream(family, script(export), entry["model"], real_key=REAL_KEY, judge=judge)
        )
        scene.upstream = upstream
        hop = LoopbackUpstream(upstream.url + BASE_PATH[family])
        ripgrep = ripgrep_binary()
        assert ripgrep is not None, "the engine tests need an rg on the PATH (OPENCODE_TEST_PATH)"

        @contextmanager
        def prepare(job: Job) -> Generator[PreparedContent]:
            yield PreparedContent(
                root=scratch,
                export=export,
                head_sha=HEAD,
                base_sha="b" * 40,
                merge_base_sha="b" * 40,
                previous_sha=None,
                comparison="full",
                files={path: "x\n" for path in EXPORTED},
                diff="diff --git a/src/app.py b/src/app.py\n+x\n",
                previous_diff="",
                omissions=(),
                skipped=(),
                metadata=json.dumps({"title": "Add a handler", "body": "Please review."}),
                prior_state="",
                deadline=0.0,
                metrics=CheckoutMetrics(0, 0, 0, 1, {}, {}),
            )

        environment = {
            runner.OPENCODE_COMMAND_VARIABLE: str(opencode_binary()),
            runner.RIPGREP_PATH_VARIABLE: str(ripgrep),
            runner.DYNAMIC_MAX_COST_VARIABLE: limit,
        }
        if (node := extra_path()) is not None:
            environment[runner.DYNAMIC_NODE_BIN_VARIABLE] = node
        result = runner.run_dynamic_job(
            job_for(family, cost),
            None,
            0.0,
            environment,
            engines=ALL_ENGINES,
            prepare=prepare,
            publish=publisher,
            native=NativeSeams(upstream_for=lambda _url: hop, engine_factory=engine),
        )
        yield FullJob(result, publisher, upstream, family, configs)
