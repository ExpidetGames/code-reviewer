# SPDX-License-Identifier: LicenseRef-Proprietary

"""The real pinned OpenCode accepts the provider block made from a job model entry (#548).

No model is called. The engine is started with the block `native_provider_config` writes for an
entry (the SDK, the loopback proxy address with a dummy key, one model with both limits) and asked
what it resolved (`GET /config/providers`, which the spike #546 found to validate a generated entry
without a model call). What the unit tests claim about the entry is checked against the engine that
reads it: a provider the engine has never heard of is built from the block alone, the limits and
flags arrive as written, a model whose status was `deprecated` upstream runs because the app writes
`active`, and the same entry written as `deprecated` is dropped (the negative control).
"""

import copy
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from opencode_support import opencode_binary, ripgrep_binary

from code_reviewer_runner.dynamic_review.config import engine_environment
from code_reviewer_runner.dynamic_review.job_model_entry import (
    JobModelEntry,
    native_provider_config,
    parse_job_model_entry,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object

pytestmark = pytest.mark.engine

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
PROXY = "http://127.0.0.1:9/v1"
DUMMY = "job-capability-0123456789abcdef"
# A provider that no snapshot of the engine knows: everything about it comes from the block.
PROVIDER = "acme-gateway"


def entry(**model: Any) -> JobModelEntry:
    document: dict[str, Any] = json.loads(
        (CONTRACTS / "examples/job-model-entry/JobModelEntry.json").read_text(encoding="utf-8")
    )
    document["providerId"] = PROVIDER
    document["modelId"] = "acme-large"
    document["model"].update(model)
    return parse_job_model_entry(document)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def get(url: str, headers: dict[str, str]) -> Any:
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as answer:
        return json.loads(answer.read())


@contextmanager
def engine_with(provider: dict[str, Any], tmp_path: Path) -> Generator[dict[str, Any]]:
    """The providers the real engine resolves from this `provider` block, by id."""
    rg = ripgrep_binary()
    directory = tmp_path / "export"
    directory.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    config_path = tmp_path / "opencode.json"
    config_path.write_text(
        json.dumps(
            {
                "provider": provider,
                "enabled_providers": list(provider),
                "share": "disabled",
                "autoupdate": False,
                "snapshot": False,
            }
        ),
        encoding="utf-8",
    )
    environment = engine_environment(
        proxy_url="http://127.0.0.1:9",
        home=str(home),
        scratch_dir=str(tmp_path),
        tools_dir=str(rg.parent) if rg is not None else None,
    )
    environment["OPENCODE_CONFIG"] = str(config_path)
    port = free_port()
    process = subprocess.Popen(
        [str(opencode_binary()), "serve", "--hostname", "127.0.0.1", "--port", str(port)],
        env=environment,
        cwd=directory,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                health = as_object(get(f"{base}/global/health", {}))
                if health is not None and health.get("healthy") is True:
                    break
            except OSError:
                pass
            if process.poll() is not None or time.monotonic() > deadline:
                raise AssertionError("the pinned engine did not become healthy")
            time.sleep(0.2)
        answer = as_object(
            get(f"{base}/config/providers", {"x-opencode-directory": str(directory)})
        )
        assert answer is not None
        providers: dict[str, Any] = {item["id"]: item for item in answer["providers"]}
        yield providers
    finally:
        if process.poll() is None:
            os.killpg(process.pid, 15)
        process.wait(timeout=20)


# #548-T10
def test_the_engine_builds_an_unknown_provider_and_its_model_from_the_block_alone(
    tmp_path: Path,
) -> None:
    block = native_provider_config(entry(), base_url=PROXY, api_key=DUMMY)

    with engine_with(block, tmp_path) as providers:
        resolved = providers[PROVIDER]["models"]["acme-large"]

        assert resolved["api"]["npm"] == "@ai-sdk/openai-compatible"
        assert resolved["limit"] == {"context": 1000000, "output": 384000}
        assert resolved["status"] == "active"
        capabilities = resolved["capabilities"]
        assert capabilities["toolcall"] is True
        assert capabilities["reasoning"] is True
        assert capabilities["temperature"] is True
        assert capabilities["interleaved"] == {"field": "reasoning_content"}
        assert providers[PROVIDER]["options"]["baseURL"] == PROXY


# #548-T10
def test_a_model_deprecated_upstream_runs_because_the_entry_says_active(tmp_path: Path) -> None:
    # The app wrote `active` for a model models.dev marks `deprecated`; the block says so.
    block = native_provider_config(entry(status="active"), base_url=PROXY, api_key=DUMMY)

    with engine_with(block, tmp_path) as providers:
        assert providers[PROVIDER]["models"]["acme-large"]["status"] == "active"


# #548-T10
def test_the_same_model_written_as_deprecated_is_dropped_by_the_engine(tmp_path: Path) -> None:
    block = native_provider_config(entry(), base_url=PROXY, api_key=DUMMY)
    # The negative control, written by hand: this is what the app's normalisation prevents.
    raw = copy.deepcopy(block)
    raw[PROVIDER]["models"]["acme-large"]["status"] = "deprecated"

    with engine_with(raw, tmp_path) as providers:
        assert "acme-large" not in providers.get(PROVIDER, {}).get("models", {})


# #548-T10
def test_a_limit_with_one_of_the_two_values_is_refused_by_the_engine(tmp_path: Path) -> None:
    block = native_provider_config(entry(), base_url=PROXY, api_key=DUMMY)
    broken = copy.deepcopy(block)
    broken[PROVIDER]["models"]["acme-large"]["limit"] = {"context": 1000}

    with pytest.raises(urllib.error.HTTPError) as raised, engine_with(broken, tmp_path):
        pass

    assert raised.value.code == 400
