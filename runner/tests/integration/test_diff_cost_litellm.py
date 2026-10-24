# SPDX-License-Identifier: LicenseRef-Proprietary

"""The cost meter of a Diff run against the real LiteLLM and a loopback server that answers like a
provider (#274, review of PR #378).

The unit tests of the meter use hand-built exceptions. What LiteLLM raises for a provider answer is
not always what the provider did: an HTTP 200 with an error in its body becomes an `APIError` with a
5xx status, and `num_retries` makes LiteLLM send a request again inside one `acompletion` call. A
request may be left out of the cost only when it was certainly rejected before any generation;
every other end leaves the cost unknown. No network beyond the loopback server, no key."""

import asyncio
import contextlib
import json
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import litellm
import pytest

from code_reviewer_runner.diff_cost import DiffCostMeter, install_cost_meter

CHARGE = 0.01

litellm.suppress_debug_info = True


@dataclass
class Step:
    """One answer of the provider: after `delay` seconds, this status and body."""

    status: int = 200
    body: dict[str, Any] | None = None
    delay: float = 0.0


def answer_body(cost: float | None = CHARGE) -> dict[str, Any]:
    usage: dict[str, Any] = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    if cost is not None:
        usage["cost"] = cost
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "created": 1,
        "model": "vendor/model",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
        ],
        "usage": usage,
    }


def error_body(status: int) -> dict[str, Any]:
    return {"error": {"message": "the provider says no", "code": status}}


@dataclass
class Provider:
    steps: list[Step] = field(default_factory=lambda: [])
    seen: int = 0
    server: ThreadingHTTPServer | None = None

    def start(self) -> None:
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                provider.seen += 1
                step = provider.steps.pop(0)
                time.sleep(step.delay)
                body = step.body if step.body is not None else answer_body()
                data = json.dumps(body).encode()
                try:
                    self.send_response(step.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        assert self.server is not None
        return f"http://127.0.0.1:{self.server.server_address[1]}/api/v1"

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()


class Boundary:
    """Stands for PR-Agent's handler module, holding the real LiteLLM function."""

    def __init__(self) -> None:
        self.acompletion = litellm.acompletion


@pytest.fixture
def provider() -> Iterator[Provider]:
    fake = Provider()
    fake.start()
    yield fake
    fake.stop()


async def ask(boundary: Boundary, provider: Provider, **options: Any) -> Any:
    return await boundary.acompletion(
        model="openrouter/vendor/model",
        messages=[{"role": "user", "content": "review this"}],
        api_base=provider.base_url,
        api_key="dummy-key",
        **options,
    )


def run_attempts(provider: Provider, steps: list[Step], **options: Any) -> DiffCostMeter:
    """A first attempt that fails (or not) and a second one, like PR-Agent's fallback model.

    Every attempt is made once, as PR-Agent's own loop does; a failure is swallowed.
    """
    provider.steps = list(steps)
    boundary = Boundary()
    meter, undo = install_cost_meter(boundary)

    async def attempts() -> None:
        for _ in steps:
            try:
                await ask(boundary, provider, **options)
            except Exception:  # pyright: ignore[reportUnusedExcept] # an attempt that fails
                continue

    try:
        asyncio.run(attempts())
    finally:
        undo()
    return meter


# A plain answer, so the rest of this file means something.
def test_an_answer_of_the_provider_is_priced(provider: Provider) -> None:
    meter = run_attempts(provider, [Step()])

    assert meter.cost_usd() == Decimal(str(CHARGE))


# #274-T03: rejected before any generation, so the attempt costs nothing.
@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 422, 429])
def test_a_request_rejected_before_any_generation_costs_nothing(
    provider: Provider, status: int
) -> None:
    meter = run_attempts(provider, [Step(status, error_body(status)), Step()])

    assert provider.seen == 2
    assert meter.cost_usd() == Decimal(str(CHARGE))


# #274-T03: the provider side may have started, finished or be billing still.
@pytest.mark.parametrize("status", [500, 502, 503, 504, 524, 408, 418, 599])
def test_a_server_error_or_an_unknown_status_leaves_the_cost_unknown(
    provider: Provider, status: int
) -> None:
    meter = run_attempts(provider, [Step(status, error_body(status)), Step()])

    assert provider.seen == 2
    assert meter.cost_usd() is None


# #274-T03: the case of the review. HTTP 200 with an error in the body and a charge in `usage`:
# LiteLLM raises an `APIError` with a 5xx status, the provider did answer and may have billed.
def test_a_200_answer_with_an_error_body_and_a_charge_leaves_the_cost_unknown(
    provider: Provider,
) -> None:
    body = {**error_body(502), "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.5}}

    meter = run_attempts(provider, [Step(200, body), Step()])

    assert provider.seen == 2
    assert meter.cost_usd() is None


# #274-T03: the same single attempt, to see what LiteLLM makes of it.
def test_litellm_raises_a_server_error_for_a_200_answer_with_an_error_body(
    provider: Provider,
) -> None:
    provider.steps = [Step(200, error_body(502))]

    async def attempt() -> BaseException:
        try:
            await ask(Boundary(), provider)
        except Exception as error:
            return error
        raise AssertionError("LiteLLM did not raise")

    error = asyncio.run(attempt())

    assert getattr(error, "status_code", None) == 502


# #274-T03: the retry of LiteLLM inside one call. The first request is not answered in time, the
# retry is. The first one may have been billed, so the cost is not exact.
def test_a_retry_inside_one_call_does_not_make_the_cost_exact(provider: Provider) -> None:
    provider.steps = [Step(delay=1.5), Step()]
    boundary = Boundary()
    meter, undo = install_cost_meter(boundary)

    async def attempt() -> None:
        with contextlib.suppress(Exception):
            await ask(boundary, provider, timeout=0.3, num_retries=2)

    try:
        asyncio.run(attempt())
    finally:
        undo()

    assert provider.seen == 2
    assert meter.cost_usd() is None


# With no retry configured nothing is retried (the baseline of the probe above).
def test_without_a_retry_a_timeout_stays_one_request_and_leaves_the_cost_unknown(
    provider: Provider,
) -> None:
    provider.steps = [Step(delay=1.5)]

    boundary = Boundary()
    meter, undo = install_cost_meter(boundary)

    async def attempt() -> None:
        with contextlib.suppress(Exception):
            await ask(boundary, provider, timeout=0.3, num_retries=0, max_retries=0)

    try:
        asyncio.run(attempt())
    finally:
        undo()

    assert provider.seen == 1
    assert meter.cost_usd() is None


# #363-T01, #363-T03: what the real LiteLLM does against a loopback provider decides whether the run
# may have used the model: a refusal before generation did not, anything else may have.
@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 422, 429])
def test_a_refusal_before_any_generation_is_no_use_of_the_model(
    provider: Provider, status: int
) -> None:
    meter = run_attempts(provider, [Step(status, error_body(status))])

    assert meter.may_have_used_the_model is False


@pytest.mark.parametrize("status", [500, 502, 503, 504, 524, 408, 418, 599])
def test_a_server_error_may_have_used_the_model(provider: Provider, status: int) -> None:
    meter = run_attempts(provider, [Step(status, error_body(status))])

    assert meter.may_have_used_the_model is True


# #363-T01: the request is still in flight when the client gives up.
def test_a_request_that_is_not_answered_in_time_may_have_used_the_model(
    provider: Provider,
) -> None:
    provider.steps = [Step(delay=1.5)]
    boundary = Boundary()
    meter, undo = install_cost_meter(boundary)

    async def attempt() -> None:
        with contextlib.suppress(Exception):
            await ask(boundary, provider, timeout=0.3, num_retries=0, max_retries=0)

    try:
        asyncio.run(attempt())
    finally:
        undo()

    assert provider.seen == 1
    assert meter.may_have_used_the_model is True


# #363-T01: cancelled by the soft timeout of the runner while the provider is still working.
def test_a_request_cancelled_while_the_provider_works_may_have_used_the_model(
    provider: Provider,
) -> None:
    provider.steps = [Step(delay=5)]
    boundary = Boundary()
    meter, undo = install_cost_meter(boundary)

    async def attempt() -> None:
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(0.3):
                await ask(boundary, provider, num_retries=0, max_retries=0)

    try:
        asyncio.run(attempt())
    finally:
        undo()

    assert provider.seen == 1
    assert meter.may_have_used_the_model is True
    assert meter.cost_usd() is None
