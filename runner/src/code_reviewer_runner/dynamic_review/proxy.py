# SPDX-License-Identifier: LicenseRef-Proprietary

"""The runner-owned model proxy of one Dynamic Review (#197).

The engine is pointed at this proxy and holds only the job's own capability; the proxy holds the
workspace credential and is the only thing that talks to the model provider. Everything the epic
demands of the model boundary happens here, before a byte reaches the provider or the engine:

- **Authenticated per job.** Every request must present the job's random capability as a bearer
  token (constant-time compare); anything else is refused with 401 before the path, the body or the
  upstream are looked at. The capability is never forwarded and the workspace key is never accepted
  from the caller, so another process or another job on the same host cannot spend the credential.
- **Only the model protocol.** `POST {base}/chat/completions` is forwarded; `GET {base}/models`
  answers from the trusted configuration. Everything else, every redirect and every query is
  refused, so the engine cannot use the proxy as a general forwarder.
- **Reservation before the call.** The serialized request is bounded in bytes and reserved in tokens
  against the epic's budget before it is sent; an over-budget call is never forwarded.
- **Model, auth and routing overrides are refused.** The request must name the one configured model;
  the proxy replaces the dummy key with the workspace credential and never lets the caller pick a
  destination.
- **OpenRouter must support every parameter (#270).** For an OpenRouter destination the proxy adds
  `provider.require_parameters: true` to the body it forwards, so a provider that would silently
  ignore `tools` or `tool_choice` is never used. It is a capability requirement, not routing: the
  engine still cannot send `provider` or any other routing field, and OpenRouter finding no provider
  for the parameters (404) ends the run with `dynamic_model_features_unsupported`.
- **Usage is authoritative, and missing usage fails.** The provider's counters settle the
  reservation; an answer without usage, or larger than reserved, stops the run instead of being
  counted as zero. The cost of a call is what the provider states, or what its usage costs by the
  provider's price list; a call that cannot be priced stops the run too.
- **One protocol towards the engine.** The engine always speaks the chat protocol. A provider with
  a protocol of its own (Anthropic's Messages API, `anthropic_wire.py`) gets a wire that translates
  the request after the checks and the answer before the accounting; everything else is shared.
- **Required features are checked, never silently downgraded.** A destination that cannot serve the
  tool choice and structured output the run needs fails with `dynamic_model_features_unsupported`;
  there is no fallback model or provider.
- **Bytes are bounded on both sides.** An oversized request is refused before forwarding, an
  oversized answer before it reaches the engine.
- **The tool loop is audited here** (`audit.py`): the tool calls of an answer are counted before the
  engine gets it, and the tool results in a request's history are checked against the per-result,
  cumulative and distinct-file bounds before the request is forwarded. A run that crosses one fails
  with the first stable cause recorded in the ledger; the engine's own session is never trusted.
- **Streaming is answered, not relayed.** The engine always asks for a stream; the provider is asked
  for the whole answer, which is bounded and accounted first, then handed back as a short stream.

`steps`, SSE events and the engine's own accounting are observation only and are never trusted here.
"""

import hmac
import http.client
import json
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request

from code_reviewer_runner.cache_usage import CacheTally, counts_of
from code_reviewer_runner.dynamic_review.audit import ToolAudit
from code_reviewer_runner.dynamic_review.budget import (
    DEFAULT_WINDOW_TOKENS,
    BudgetLedger,
    LimitError,
    Reservation,
    UnitCosts,
    exact_cost,
)
from code_reviewer_runner.dynamic_review.call_outcome import describe_call
from code_reviewer_runner.dynamic_review.call_trace import answer_finish_reason, answer_tool_names
from code_reviewer_runner.dynamic_review.completion_stream import completion_as_stream
from code_reviewer_runner.dynamic_review.config import PROXY_CAPABILITY_BYTES, PROXY_PROVIDER_ID
from code_reviewer_runner.dynamic_review.net import no_redirect_opener
from code_reviewer_runner.dynamic_review.wrap_up import (
    FINAL_ATTEMPTS,
    RECOVERY_INSTRUCTION,
    WRAP_UP_INSTRUCTION,
    answer_from_text,
    final_reply_problem,
    offers_structured_output,
    retry_request,
    returns_structured_output,
    wrap_up_request,
)
from code_reviewer_runner.error_mapping import is_context_length_exceeded, llm_status_code
from code_reviewer_runner.job import JobCapabilities
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.llm_providers import PROXY_FORWARDED_FIELDS, LlmProviderSpec
from code_reviewer_runner.provider_wire import UpstreamWire
from code_reviewer_runner.result import ErrorCode

# The protocol the run requires (`wrap_up.py` names the tool and the choice). The pinned OpenCode
# uses tool calling for its StructuredOutput return, so a destination that cannot force a tool
# choice is not usable.

_REQUEST_TIMEOUT_SECONDS = 120.0
# `PROXY_FORWARDED_FIELDS` are the only request fields that reach the provider. Everything else the
# engine sends is dropped, and the destination, the model and the output bound come from trusted
# configuration, never from here. `stream` and `stream_options` are absent on purpose: the provider
# is always asked for the whole answer (see `completion_stream.py`), whatever the engine asked for.
# Fields that would steer a request to another route or destination. They are not merely dropped:
# an engine that sends one is misbehaving and the run stops.
_ROUTING_FIELDS = frozenset(
    {
        "provider",
        "route",
        "models",
        "transforms",
        "plugins",
        "endpoint",
        "base_url",
        "api_base",
        "url",
    }
)
# `secrets.token_urlsafe(n)` yields ceil(4n/3) characters: the shortest acceptable capability.
_MIN_CAPABILITY_CHARS = -(-PROXY_CAPABILITY_BYTES * 4 // 3)
_BEARER = "bearer "


# What a trusted capability descriptor says about one configured model/destination. The operator
# supplies it with the credential; nothing at run time may invent it.
@dataclass(frozen=True)
class DynamicCapabilities:
    """The features the selected destination must have. A missing one fails the run."""

    tool_choice_required: bool
    structured_output: bool
    max_output_tokens: int
    # The model's context window in tokens: what a request and its output allowance must fit. It
    # belongs to the model, not to the project (the Diff token budget `llm.maxTokens` is a different thing and
    # plays no part here). A descriptor that omits it gets the conservative default.
    context_window_tokens: int = DEFAULT_WINDOW_TOKENS
    # What a call reserves before it is sent. Optional: without it a call reserves a floor.
    unit_costs: UnitCosts | None = None
    # What a call reserves of `max_output_tokens` against the cost limit (#533); None reserves
    # all of it. Set from the model's wire (`with_reserved_output`), never from the job.
    reserved_output_tokens: int | None = None

    def check_required(self) -> None:
        if not self.tool_choice_required:
            raise LimitError(
                ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
                "the configured model does not support a required tool choice",
            )
        if not self.structured_output:
            raise LimitError(
                ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
                "the configured model does not support structured output through tool calling",
            )
        if self.max_output_tokens < 1:
            raise LimitError(
                ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
                "the configured model has no usable output bound",
            )
        if self.context_window_tokens <= self.max_output_tokens:
            raise LimitError(
                ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
                "the configured model has no usable context window",
            )


# The model id the app ships as the default Dynamic model (`DEFAULT_DYNAMIC_MODEL` in
# app/src/review-settings/settings.ts; app/src/ci/dynamic-default-model.test.ts keeps the two equal)
# and the descriptor of it, verified on OpenRouter: tools, tool_choice and response_format /
# structured outputs are supported. It ships with the image, so a fix reaches every deployment with
# the next build, whatever a platform stored as a variable.
DEFAULT_DYNAMIC_MODEL = "deepseek/deepseek-v4.1-flash"
# The window and the unit costs are the ones OpenRouter's public model list gives for it
# (https://openrouter.ai/api/v1/models, read on 2026-10-14: context_length 1048576, pricing prompt
# 0.00000002016 and completion 0.000000891 USD per token). They only size a reservation: a window
# the provider does not really give ends in its own context error, and the cost of a call is
# always the `usage.cost` it reports. The output allowance is 32768 (#309): a review of up to 30
# findings plus the reasoning tokens, which count against `max_tokens`, does not fit 8192, and a
# turn cut off there ends without an answer. OpenRouter states `max_completion_tokens` 943718 for
# the model's top provider and 131072 or more for each of its endpoints
# (https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints, read on 2026-10-14),
# so the value is below every limit. Every call reserves it at the output price against the cost
# limit, so it is bounded by money, not by this number. The app sends the same value in a job's
# descriptor (`app/src/llm/dynamic-capabilities.ts`), which is what a run is normally held to.
DEFAULT_MODEL_CAPABILITIES = DynamicCapabilities(
    tool_choice_required=True,
    structured_output=True,
    max_output_tokens=32_768,
    context_window_tokens=1_048_576,
    unit_costs=UnitCosts(
        input_usd_per_mtok=Decimal("0.02016"), output_usd_per_mtok=Decimal("0.891")
    ),
)


def with_cache_unit_costs(
    capabilities: DynamicCapabilities, cache_costs: tuple[Decimal, Decimal] | None
) -> DynamicCapabilities:
    """The capabilities with the cache prices of the provider's own list (#540): what a million
    tokens read from and written to its cache cost. They only size a reservation. The descriptor of
    a job never names them; a provider without a list (None) leaves the prompt priced as input."""
    unit_costs = capabilities.unit_costs
    if cache_costs is None or unit_costs is None:
        return capabilities
    return replace(
        capabilities,
        unit_costs=replace(
            unit_costs,
            cache_read_usd_per_mtok=cache_costs[0],
            cache_write_usd_per_mtok=cache_costs[1],
        ),
    )


def with_reserved_output(
    capabilities: DynamicCapabilities, wire: UpstreamWire
) -> DynamicCapabilities:
    """The capabilities with the most a call of this model reserves of its output, as its wire says
    (#533). What a call really reserves is the output the run has shown, up to this cap (#540)."""
    return replace(
        capabilities,
        reserved_output_tokens=wire.reserved_output_tokens(capabilities.max_output_tokens),
    )


def capabilities_from_config(raw: str | None, model: str | None = None) -> DynamicCapabilities:
    """The operator-supplied capability descriptor of the selected model/destination.

    The descriptor is trusted runner configuration, never repository input. Anything missing or
    unusable fails closed: the run must not assume a destination can serve the required tool choice
    and structured output. The one exception is no descriptor at all for exactly the shipped
    default model, whose built-in descriptor applies; any descriptor the operator sets, usable or
    not, takes precedence, and every other model needs one (or the descriptor the app sends with the
    job, see `capabilities_for_job`).
    """
    parsed = _operator_descriptor(raw)
    if parsed is not None:
        return parsed[0]
    if model == DEFAULT_DYNAMIC_MODEL:
        return DEFAULT_MODEL_CAPABILITIES
    raise LimitError(
        ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
        "no trusted capability descriptor is configured for the model",
    )


def capabilities_for_job(
    raw: str | None, model: str | None, job: JobCapabilities | None
) -> DynamicCapabilities:
    """The descriptor a Dynamic run is held to (#279): the job's, narrowed by the operator's.

    Precedence, all of it trusted (the operator's variable, the app's reading of the provider's
    metadata) and none of it from the repository:

    1. Without a descriptor in the job, exactly `capabilities_from_config`: the operator's value, or
       the built-in one for the default model, or a refusal.
    2. With one, and no operator descriptor: the job's. Any tool-capable model runs without the
       operator describing it. A model whose metadata carries no unit prices has none here, except
       the default model, which keeps its built-in prices; `dynamic_ledger` refuses the rest.
    3. With both, the operator's is a ceiling and the result is the intersection: both features
       must hold, the smaller output limit wins, the smaller window wins when the operator names
       one, and the higher unit price wins, so the job can only narrow what the operator allows
       and never lower the price of a reservation. An operator value that is set but unusable
       fails whatever the job says.

    The built-in descriptor of the default model is a fallback, never a ceiling.
    """
    if job is None:
        return capabilities_from_config(raw, model=model)
    parsed = _operator_descriptor(raw)
    unit_costs = _job_unit_costs(job)
    if unit_costs is None and parsed is None and model == DEFAULT_DYNAMIC_MODEL:
        unit_costs = DEFAULT_MODEL_CAPABILITIES.unit_costs
    from_job = DynamicCapabilities(
        tool_choice_required=job.tool_choice_required,
        structured_output=job.structured_output,
        max_output_tokens=job.max_output_tokens,
        context_window_tokens=job.context_window_tokens,
        unit_costs=unit_costs,
    )
    if parsed is None:
        return from_job
    ceiling, window_named = parsed
    return DynamicCapabilities(
        tool_choice_required=from_job.tool_choice_required and ceiling.tool_choice_required,
        structured_output=from_job.structured_output and ceiling.structured_output,
        max_output_tokens=min(from_job.max_output_tokens, ceiling.max_output_tokens),
        context_window_tokens=(
            min(from_job.context_window_tokens, ceiling.context_window_tokens)
            if window_named
            else from_job.context_window_tokens
        ),
        unit_costs=_higher_costs(from_job.unit_costs, ceiling.unit_costs),
    )


def _job_unit_costs(job: JobCapabilities) -> UnitCosts | None:
    if job.input_usd_per_mtok is None or job.output_usd_per_mtok is None:
        return None
    return UnitCosts(
        input_usd_per_mtok=job.input_usd_per_mtok, output_usd_per_mtok=job.output_usd_per_mtok
    )


def _higher_costs(first: UnitCosts | None, second: UnitCosts | None) -> UnitCosts | None:
    if first is None or second is None:
        return first or second
    return UnitCosts(
        input_usd_per_mtok=max(first.input_usd_per_mtok, second.input_usd_per_mtok),
        output_usd_per_mtok=max(first.output_usd_per_mtok, second.output_usd_per_mtok),
    )


def _operator_descriptor(raw: str | None) -> tuple[DynamicCapabilities, bool] | None:
    """The operator's descriptor and whether it names a context window; None when it is blank."""
    # A blank value (a platform may store an empty field as a space) is as empty as an empty one.
    raw = raw.strip() if raw else raw
    if not raw:
        return None
    try:
        value: Any = json.loads(raw)
    except ValueError:
        raise LimitError(
            ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
            "the capability descriptor is not valid JSON",
        ) from None
    document = as_object(value)
    if document is None:
        raise LimitError(
            ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
            "the capability descriptor is not an object",
        )
    output: Any = document.get("max_output_tokens")
    if isinstance(output, bool) or not isinstance(output, int):
        raise LimitError(
            ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED,
            "the capability descriptor has no output bound",
        )
    descriptor = DynamicCapabilities(
        tool_choice_required=document.get("tool_choice_required") is True,
        structured_output=document.get("structured_output") is True,
        max_output_tokens=output,
        context_window_tokens=_window(document),
        unit_costs=_unit_costs(document),
    )
    return descriptor, "context_window_tokens" in document


def _unusable(detail: str) -> LimitError:
    return LimitError(ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED, detail)


def _window(document: dict[str, Any]) -> int:
    if "context_window_tokens" not in document:
        return DEFAULT_WINDOW_TOKENS
    window: Any = document["context_window_tokens"]
    if isinstance(window, bool) or not isinstance(window, int) or window < 1:
        raise _unusable("the capability descriptor has no usable context window")
    return window


def _unit_costs(document: dict[str, Any]) -> UnitCosts | None:
    present = {"input_usd_per_mtok", "output_usd_per_mtok"} & document.keys()
    if not present:
        return None
    if len(present) == 1:
        raise _unusable("the capability descriptor names only one of the two unit costs")
    costs: list[Decimal] = []
    for key in ("input_usd_per_mtok", "output_usd_per_mtok"):
        value = exact_cost(document[key])
        if value is None:
            raise _unusable("the capability descriptor has an unusable unit cost")
        costs.append(value)
    return UnitCosts(input_usd_per_mtok=costs[0], output_usd_per_mtok=costs[1])


@dataclass(frozen=True)
class ProxyResponse:
    status: int
    body: bytes
    content_type: str = "application/json"


# A transport is what actually sends the forwarded request upstream; a test replaces it so nothing
# leaves loopback. `post(url, body, headers, limit)` returns the status and at most `limit` bytes of
# the answer: the proxy asks for one byte more than the response bound, so an oversized answer is
# detected without ever being buffered whole.
UpstreamPost = Callable[[str, bytes, dict[str, str], int], tuple[int, bytes]]


def _http_post(url: str, body: bytes, headers: dict[str, str], limit: int) -> tuple[int, bytes]:
    # A trusted destination is one URL, not a route: the opener never follows a redirect, so the
    # credential is sent to the configured URL once and nowhere else.
    request = Request(url, data=body, headers=headers, method="POST")
    try:
        with no_redirect_opener().open(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
            return response.status, response.read(limit)
    except HTTPError as error:
        if 300 <= error.code < 400:
            raise LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "the provider answered with a redirect"
            ) from None
        return error.code, error.read(limit)


def error_body(code: ErrorCode, detail: str) -> bytes:
    """The stable error shape the engine sees: a code, never a message with data in it."""
    return json.dumps({"error": {"code": code.value, "detail": detail}}).encode("utf-8")


UNAUTHORIZED = ProxyResponse(
    status=401,
    body=error_body(ErrorCode.DYNAMIC_POLICY_VIOLATION, "the request carries no valid capability"),
)


@dataclass(frozen=True)
class _Attempt:
    """One settled answer of the provider: its body as received and the decoded completion."""

    body: bytes
    completion: dict[str, Any]


class ModelProxy:
    """One proxy per job. `handle` is the whole policy; `serve` only puts it on loopback."""

    def __init__(
        self,
        *,
        ledger: BudgetLedger,
        base_path: str,
        model: str,
        upstream_url: str,
        upstream_api_key: str,
        upstream_model: str,
        capabilities: DynamicCapabilities,
        capability: str,
        post: UpstreamPost = _http_post,
        provider: LlmProviderSpec,
        require_parameters: bool = False,
        superseded: Callable[[], bool] = lambda: False,
    ) -> None:
        if len(capability) < _MIN_CAPABILITY_CHARS:
            raise LimitError(
                ErrorCode.DYNAMIC_CONFIG_INVALID, "the proxy capability is not strong enough"
            )
        self._capability = capability.encode("utf-8")
        self.ledger = ledger
        self.base_path = base_path.rstrip("/")
        self.model = model
        self.upstream_url = upstream_url
        self.upstream_api_key = upstream_api_key
        self.upstream_model = upstream_model
        self.capabilities = capabilities
        self.audit = ToolAudit(ledger)
        # How much of the input of the run came from the provider's cache (counts only, #539).
        self.cache_tally = CacheTally()
        self._post = post
        # The registry entry of the job's provider: the require-parameters field, the matcher for
        # "no endpoint supports them" and the extractor of the stated cost (the runner decides,
        # never the engine).
        self._provider = provider
        # How this provider is spoken to for the configured model: its endpoint's headers, the
        # translation of the request and of the answer (the engine speaks the chat protocol).
        self._wire = provider.wire(upstream_model)
        # True when the destination is the provider itself and its entry has the mechanism.
        self._require_parameters = require_parameters and provider.require_parameters is not None
        # #396: true once a newer push replaced the run. A request in flight finishes (and is
        # counted); a new one is refused, with the stable code `superseded`, before anything is
        # forwarded or reserved.
        self._superseded = superseded
        # Requests being answered right now. A superseded run lets them finish (their cost is
        # measured) before the server goes away: `wait_idle`.
        self._in_flight = 0
        self._idle = threading.Condition()
        # The proxy starts only after the capability descriptor was proven: an unusable destination
        # is a failure before the first request, not a downgrade at the first call.
        self.capabilities.check_required()

    # -- policy ---------------------------------------------------------------

    def authorized(self, headers: Mapping[str, str]) -> bool:
        """True only for this job's capability. Constant-time; the real key never qualifies."""
        value = headers.get("Authorization", "")
        if value[: len(_BEARER)].lower() != _BEARER:
            return False
        presented = value[len(_BEARER) :].encode("utf-8", errors="replace")
        return hmac.compare_digest(presented, self._capability)

    def handle(
        self, method: str, path: str, body: bytes, headers: Mapping[str, str]
    ) -> ProxyResponse:
        """The whole decision for one request. Never raises; every failure is a stable code."""
        if not self.authorized(headers):
            return UNAUTHORIZED
        with self._idle:
            self._in_flight += 1
        try:
            return self._handle(method, path, body)
        except LimitError as error:
            # The engine only sees an HTTP error; the stable cause is kept for the run's result.
            # 403, not 5xx: a deterministic refusal must not be retried (every retry is a call).
            self.ledger.record_failure(error)
            return ProxyResponse(status=403, body=error_body(error.code, error.detail))
        finally:
            with self._idle:
                self._in_flight -= 1
                self._idle.notify_all()

    def wait_idle(self, timeout: float) -> bool:
        """Wait until no request is being answered; False when `timeout` ran out first."""
        with self._idle:
            return self._idle.wait_for(lambda: self._in_flight == 0, timeout=timeout)

    def _handle(self, method: str, path: str, body: bytes) -> ProxyResponse:
        if path == f"{self.base_path}/models":
            if method != "GET":
                raise LimitError(
                    ErrorCode.DYNAMIC_POLICY_VIOLATION, "only the model protocol is allowed"
                )
            return ProxyResponse(status=200, body=self._models_body())
        if path != f"{self.base_path}/chat/completions" or method != "POST":
            raise LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "only the model protocol is allowed"
            )
        if self._superseded():
            raise LimitError(ErrorCode.SUPERSEDED, "the run was superseded by a newer push")
        self.ledger.check_request_bytes(len(body))
        request = self._decode(body)
        self._check_model(request)
        wants_stream = request.get("stream") is True
        # The tool results the engine is about to show the model are audited before anything is
        # forwarded: content over a bound is never sent to the provider. The audit also hands back
        # the history with the reminder wrappers neutralised (#232); that is what is forwarded,
        # counted and reserved.
        if "messages" in request:
            request["messages"] = self.audit.results_in_request(request["messages"])
        # A request the policy refuses spends nothing: build it before reserving the call.
        forwarded = self._forward_body(request)
        reservation = self.ledger.reserve_call(
            forwarded.decode("utf-8", errors="replace"),
            output_tokens=self._output_allowance(request),
            can_wrap_up=offers_structured_output(request),
            wrap_up_text=WRAP_UP_INSTRUCTION,
            recovery_text=RECOVERY_INSTRUCTION,
        )
        final_request: dict[str, Any] | None = None
        if reservation.final:
            # The ledger decided, from its own cost and clock (#293), or from the recovery the
            # adapter armed after a turn without an answer (#309), that this is the last call of
            # the run: it can only return the answer, whatever the request asked for.
            instruction = RECOVERY_INSTRUCTION if reservation.recovery else WRAP_UP_INSTRUCTION
            final_request = wrap_up_request(request, instruction)
            forwarded = self._forward_body(final_request)
        attempt = self._attempt(forwarded, reservation)
        if isinstance(attempt, ProxyResponse):
            return attempt
        if final_request is not None:
            attempt = self._enforce_answer(attempt, final_request)
            if isinstance(attempt, ProxyResponse):
                return attempt
        # The tool calls the model asked for are counted before the engine can run any of them.
        self.audit.calls_in_answer(attempt.completion)
        if reservation.final and not returns_structured_output(attempt.completion):
            # The last call did not return the answer (#301 F3): whatever the engine does next, the
            # failure is the model's, and a further request says so instead of blaming the limit.
            self.ledger.note_final_unanswered()
        if not wants_stream:
            return ProxyResponse(status=200, body=attempt.body)
        stream = completion_as_stream(attempt.completion)
        if stream is None:
            raise LimitError(ErrorCode.LLM_OUTPUT_INVALID, "the provider answer has no message")
        return ProxyResponse(status=200, body=stream, content_type="text/event-stream")

    def _attempt(self, forwarded: bytes, reservation: Reservation) -> "_Attempt | ProxyResponse":
        """One request to the provider, reserved before and settled after: its answer, or the
        response that ends the run (a provider refusal, a transport failure)."""
        started_ms = int(self.ledger.elapsed_seconds() * 1000)
        try:
            status, response_body = self._post(
                self.upstream_url,
                forwarded,
                self._wire.headers(self.upstream_api_key),
                self.ledger.limits.max_response_bytes + 1,
            )
        except (OSError, http.client.HTTPException) as error:
            # No answer exists (timeout, refused or reset connection, truncated read). Like a
            # provider error it ends the run with a stable code of its own; the reservation stays
            # spent and the engine gets a 5xx that is no budget refusal. The exception text is
            # never passed on: it can carry the destination.
            self._trace_failed_call(started_ms, reservation)
            return self._transport_failure(error)
        try:
            self.ledger.check_response_bytes(len(response_body))
        except LimitError:
            # The call was made and may have been billed whatever its answer was: it is traced.
            self._trace_failed_call(started_ms, reservation)
            raise
        if status != 200:
            self._trace_failed_call(started_ms, reservation)
            # The run ends with the provider's stable code; no partial success is claimed and no
            # counter is invented for a refused call (the reservation stays spent).
            refusal, code = self._provider_error(status, response_body)
            self.ledger.record_failure(LimitError(code, "the model provider refused the request"))
            return ProxyResponse(status=status, body=refusal)
        # The answer in the chat shape the rest of the proxy works on (the provider's own, when it
        # speaks that protocol too); its usage is the provider's, translated.
        response_body = self._wire.decode_response(response_body)
        completion = self._completion(response_body)
        usage = self._usage(completion)
        if usage == (None, None):
            self._trace_failed_call(
                started_ms, reservation, finish_reason=answer_finish_reason(completion)
            )
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the provider did not report usage"
            )
        # The provider is authoritative: its counters replace the reservation. A counter above the
        # reservation is not added up, it fails the run.
        cache_read, cache_write = self._cache_usage(completion)
        cost = self._cost(completion)
        # Noted before the settlement: a call the ledger then stops the run for is in the trace too.
        self.ledger.trace.model_call(
            t_ms=started_ms,
            prompt_tokens=usage[0],
            cache_read=cache_read,
            cache_write=cache_write,
            completion_tokens=usage[1],
            cost=cost,
            finish_reason=answer_finish_reason(completion),
            final=reservation.final,
            tool_names=answer_tool_names(completion),
        )
        self.ledger.settle_call(
            reservation,
            prompt_tokens=usage[0],
            completion_tokens=usage[1],
            cost=cost,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
        )
        self.ledger.note_call_outcome(describe_call(completion, final=reservation.final))
        self.cache_tally.add(completion.get("usage"))
        return _Attempt(body=response_body, completion=completion)

    def _trace_failed_call(
        self, started_ms: int, reservation: Reservation, *, finish_reason: str | None = None
    ) -> None:
        """A call that ended the run without a usable answer (refused, never answered, too large, or
        answered without usage) was reserved and may have been billed: it is in the trace with
        nothing known about it but what the answer said about its ending. No tool of it ever ran."""
        self.ledger.trace.model_call(
            t_ms=started_ms,
            prompt_tokens=None,
            cache_read=None,
            cache_write=None,
            completion_tokens=None,
            cost=None,
            finish_reason=finish_reason,
            final=reservation.final,
            tool_names=[],
        )

    def _enforce_answer(
        self, attempt: "_Attempt", request: dict[str, Any]
    ) -> "_Attempt | ProxyResponse":
        """Make the reply of a final call the answer, or as close to it as the limits allow (#312).

        A reply that put the review in its text as JSON becomes the tool call. A reply that is not
        the answer is asked for again with the concrete problem, up to `FINAL_ATTEMPTS` requests in
        all and only while the ledger has room for one more. What is returned is the last reply,
        valid or not: a reply that still fails is the model's failure, and the runner's own
        validation says which field.
        """
        for _ in range(FINAL_ATTEMPTS - 1):
            reply = attempt.completion  # what the model said, before a text answer is rewritten
            wrapped = answer_from_text(reply)
            if wrapped is not None:
                attempt = _Attempt(body=json.dumps(wrapped).encode("utf-8"), completion=wrapped)
            problem = final_reply_problem(attempt.completion)
            if problem is None:
                return attempt
            request = retry_request(request, reply, problem)
            body = self._forward_body(request)
            reservation = self.ledger.try_reserve_final_retry(
                body.decode("utf-8", errors="replace"),
                output_tokens=self._output_allowance(request),
            )
            if reservation is None:
                return attempt
            retried = self._attempt(body, reservation)
            if isinstance(retried, ProxyResponse):
                return retried
            attempt = retried
        wrapped = answer_from_text(attempt.completion)
        if wrapped is not None:
            attempt = _Attempt(body=json.dumps(wrapped).encode("utf-8"), completion=wrapped)
        return attempt

    def _transport_failure(self, error: Exception) -> ProxyResponse:
        timed_out = isinstance(error, TimeoutError) or (
            isinstance(error, URLError) and isinstance(error.reason, TimeoutError)
        )
        code = ErrorCode.LLM_TIMEOUT if timed_out else ErrorCode.LLM_UNAVAILABLE
        detail = (
            "the model provider did not answer in time"
            if timed_out
            else "the model provider could not be reached"
        )
        self.ledger.record_failure(LimitError(code, detail))
        return ProxyResponse(status=504 if timed_out else 502, body=error_body(code, detail))

    def _decode(self, body: bytes) -> dict[str, Any]:
        try:
            value: Any = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "the request is not JSON"
            ) from None
        document = as_object(value)
        if document is None:
            raise LimitError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "the request is not an object")
        return document

    def _check_model(self, request: dict[str, Any]) -> None:
        requested = request.get("model")
        # The engine names the model through the trusted provider (`<provider>/<model>` or the bare
        # name); anything else is an override the run refuses rather than honours.
        if requested not in (self.model, f"{PROXY_PROVIDER_ID}/{self.model}"):
            raise LimitError(ErrorCode.DYNAMIC_POLICY_VIOLATION, "the request names another model")

    def _output_allowance(self, request: dict[str, Any]) -> int:
        raw = request.get("max_tokens", request.get("max_completion_tokens"))
        if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
            return self.capabilities.max_output_tokens
        return min(raw, self.capabilities.max_output_tokens)

    def _forward_body(self, request: dict[str, Any]) -> bytes:
        """The request as the trusted destination takes it: built from an allowlist of fields.

        The model, the output bound and (through the transport) the destination and credential are
        set here from trusted configuration; whatever else the caller sent is dropped. The tool
        choice the engine asked for is kept — refusing it would be a silent downgrade. The provider
        is always asked for the whole answer: a streamed request is answered from the bounded,
        accounted completion, never relayed."""
        if _ROUTING_FIELDS & request.keys():
            raise LimitError(
                ErrorCode.DYNAMIC_POLICY_VIOLATION, "the request tries to choose a route"
            )
        forwarded: dict[str, Any] = {
            field: value for field, value in request.items() if field in PROXY_FORWARDED_FIELDS
        }
        forwarded["model"] = self.upstream_model
        forwarded["max_tokens"] = self._output_allowance(request)
        forwarded["stream"] = False
        mechanism = self._provider.require_parameters
        if self._require_parameters and mechanism is not None:
            forwarded[mechanism.body_field] = dict(mechanism.body_value)
        # Compact UTF-8 like the engine's own serialisation: the reservation is made on these bytes,
        # and `\uXXXX` escapes of non-ASCII text would inflate it. A lone surrogate (a JSON escape
        # the engine or the provider can emit when a token splits an emoji) has no UTF-8 form: that
        # one request is escaped as ASCII instead, and those bytes are the ones reserved and sent.
        body = self._wire.encode_request(forwarded)
        try:
            return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except UnicodeEncodeError:
            return json.dumps(body, ensure_ascii=True, separators=(",", ":")).encode("ascii")

    @staticmethod
    def _completion(body: bytes) -> dict[str, Any]:
        try:
            value: Any = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the provider answer is not JSON"
            ) from None
        document = as_object(value)
        if document is None:
            raise LimitError(
                ErrorCode.DYNAMIC_ACCOUNTING_FAILED, "the provider answer is not an object"
            )
        return document

    @staticmethod
    def _usage(document: dict[str, Any]) -> tuple[int | None, int | None]:
        usage = as_object(document.get("usage"))
        if usage is None:
            return None, None
        prompt: Any = usage.get("prompt_tokens")
        completion: Any = usage.get("completion_tokens")
        prompt_tokens = prompt if isinstance(prompt, int) and not isinstance(prompt, bool) else None
        completion_tokens = (
            completion if isinstance(completion, int) and not isinstance(completion, bool) else None
        )
        return prompt_tokens, completion_tokens

    @staticmethod
    def _cache_usage(document: dict[str, Any]) -> tuple[int | None, int | None]:
        """What the provider says it read from and wrote to its cache (#540): the cost guard prices
        the next call from it. The one reader of the cache fields is `cache_usage.counts_of` (#539);
        a provider without a cache, or a count that cannot be true, reads as no cache use."""
        counts = counts_of(document.get("usage"))
        return (None, None) if counts is None else (counts.read, counts.written)

    def _cost(self, document: dict[str, Any]) -> Decimal | None:
        """The cost of this call by the rule of the provider, or None when it has none.

        The entry of the provider says how: the charge it states (OpenRouter: `usage.cost`), read
        and never computed, or its usage priced with its own list (Anthropic, exact decimals). A
        call that cannot be priced simply has no known cost, which stops the run.
        """
        usage = as_object(document.get("usage"))
        return None if usage is None else self._provider.cost_extractor(self.upstream_model, usage)

    def _provider_error(self, status: int, body: bytes) -> tuple[bytes, ErrorCode]:
        # The provider has no endpoint that supports every parameter of the request (#270): the
        # model cannot serve the run, which is no unknown model.
        if (
            status == 404
            and self._require_parameters
            and self._provider.no_endpoint_for_parameters(body.decode("utf-8", errors="replace"))
        ):
            code = ErrorCode.DYNAMIC_MODEL_FEATURES_UNSUPPORTED
            return error_body(code, "no provider supports every parameter of the request"), code
        # The request does not fit the model's context: the real limit of the provider, behind the
        # estimate and the window check of the ledger. A code of its own, not a bad request.
        if is_context_length_exceeded(status, body.decode("utf-8", errors="replace")):
            code = ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED
            return error_body(code, "the request is larger than the model's context"), code
        # The static path's table (error_mapping.py); a status it has no rule for is a bad request.
        code = llm_status_code(status) or ErrorCode.LLM_BAD_REQUEST
        return error_body(code, "the model provider refused the request"), code

    def _models_body(self) -> bytes:
        return json.dumps(
            {"object": "list", "data": [{"id": self.model, "object": "model"}]}
        ).encode("utf-8")

    # -- transport ------------------------------------------------------------

    def serve(self, host: str, port: int = 0) -> "ProxyServer":
        """Put the policy on loopback (127.0.0.1). Reaching the port is not enough: only the
        holder of the job's capability gets an answer."""
        return ProxyServer(self, host, port)


class _Handler(BaseHTTPRequestHandler):
    server_version = "code-reviewer-proxy/1"
    protocol_version = "HTTP/1.1"

    @property
    def proxy(self) -> ModelProxy:
        return self.server.proxy  # type: ignore[attr-defined]

    def _answer(self, response: ProxyResponse) -> None:
        try:
            self.send_response(response.status)
            self.send_header("Content-Type", response.content_type)
            self.send_header("Content-Length", str(len(response.body)))
            self.end_headers()
            self.wfile.write(response.body)
        except (BrokenPipeError, ConnectionResetError):
            # The engine went away (a refused run ends its process group): nobody to answer.
            self.close_connection = True

    def _credentials(self) -> dict[str, str]:
        return {"Authorization": self.headers.get("Authorization", "")}

    def _refuse_unauthorized(self) -> bool:
        if self.proxy.authorized(self._credentials()):
            return False
        # The body is not read for a caller that proved nothing: close instead of draining it.
        self.close_connection = True
        self._answer(UNAUTHORIZED)
        return True

    def do_GET(self) -> None:
        if self._refuse_unauthorized():
            return
        self._answer(self.proxy.handle("GET", self.path, b"", self._credentials()))

    def do_POST(self) -> None:
        if self._refuse_unauthorized():
            return
        length = self.headers.get("Content-Length", "")
        if not length.isdigit():
            self._answer(
                ProxyResponse(411, error_body(ErrorCode.DYNAMIC_POLICY_VIOLATION, "no length"))
            )
            return
        remaining = int(length)
        # Read at most one byte more than the bound: a body that is too large is refused without
        # buffering it.
        cap = self.proxy.ledger.limits.max_request_bytes
        if remaining > cap:
            self._answer(
                ProxyResponse(
                    413,
                    error_body(
                        ErrorCode.DYNAMIC_BUDGET_EXCEEDED,
                        "the request exceeds the protocol byte bound",
                    ),
                )
            )
            return
        self._answer(
            self.proxy.handle("POST", self.path, self.rfile.read(remaining), self._credentials())
        )

    def log_message(self, format: str, *args: Any) -> None:
        return  # never write a request line (it could carry data) anywhere


class ProxyServer:
    """A running loopback proxy. `url` is what the engine's provider is pointed at."""

    def __init__(self, proxy: ModelProxy, host: str, port: int) -> None:
        self._proxy = proxy
        self._server = ThreadingHTTPServer((host, port), _Handler)
        self._server.daemon_threads = True
        self._server.proxy = proxy  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> "ProxyServer":
        self._thread.start()
        return self

    def stop(self, drain_seconds: float = 0.0) -> None:
        """Stop serving. With `drain_seconds` the requests already being answered finish first
        (a superseded run: their cost is measured and must be in the result); new ones are
        refused by the proxy's own supersede check meanwhile."""
        if drain_seconds > 0:
            self._proxy.wait_idle(drain_seconds)
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)
