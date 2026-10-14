// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  checkModelCapabilities,
  createModelCapabilityChecker,
  MODEL_METADATA_MAX_BYTES,
  type ModelCapabilityResult,
} from "./model-capabilities.ts";

const BASE = "https://llm.example.test/api/v1";

type Endpoint = {
  supported_parameters: string[];
  max_completion_tokens?: number | null;
};

function endpointsAnswer(endpoints: Endpoint[], status = 200): Response {
  return new Response(
    JSON.stringify({
      data: { id: "vendor/model", name: "Model", endpoints },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

type Call = { url: string; init: RequestInit };

function recordingFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(answer());
  };
  return { calls, fetchImpl };
}

async function check(
  answer: () => Response | Promise<Response>,
  modelId = "vendor/model",
) {
  const { calls, fetchImpl } = recordingFetch(answer);
  const result = await checkModelCapabilities({
    baseUrl: BASE,
    modelId,
    fetchImpl,
    timeoutMs: 200,
    log: () => undefined,
  });
  return { result, calls };
}

describe("reading the tool support of a model from the provider's metadata", () => {
  // #269-T01
  it("is supported when an endpoint lists tools and tool_choice, and returns what it read", async () => {
    const { result, calls } = await check(() =>
      endpointsAnswer([
        { supported_parameters: ["temperature", "max_tokens"] },
        {
          supported_parameters: [
            "tools",
            "tool_choice",
            "response_format",
            "structured_outputs",
          ],
          max_completion_tokens: 32_768,
        },
      ]),
    );

    expect(result).toEqual({
      outcome: "supported",
      capabilities: {
        tools: true,
        toolChoice: true,
        responseFormat: true,
        structuredOutputs: true,
        maxCompletionTokens: 32_768,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/models/vendor/model/endpoints`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  // #269-T01
  it("needs tools and tool_choice on the same endpoint", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        { supported_parameters: ["tools"] },
        { supported_parameters: ["tool_choice"] },
      ]),
    );

    expect(result.outcome).toBe("unsupported");
  });

  // #269-T02
  it("is unsupported when the endpoints list tools but not tool_choice", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        { supported_parameters: ["tools", "temperature"] },
        { supported_parameters: ["tools", "response_format"] },
      ]),
    );

    expect(result).toEqual({
      outcome: "unsupported",
      capabilities: {
        tools: true,
        toolChoice: false,
        responseFormat: true,
        structuredOutputs: false,
        maxCompletionTokens: null,
      },
    });
  });

  // #269-T02
  it("is unsupported for a model without any endpoint", async () => {
    const { result } = await check(() => endpointsAnswer([]));

    expect(result.outcome).toBe("unsupported");
  });

  // #269-T03
  it("is an unknown model when the provider answers 404", async () => {
    const { result } = await check(
      () => new Response('{"error":{"message":"not found"}}', { status: 404 }),
    );

    expect(result).toEqual({ outcome: "unknown_model" });
  });

  // #269-T03
  it("is an unknown model without a request when the name has no author and slug", async () => {
    for (const modelId of ["just-a-name", "a/b/c", "/slug", "author/"]) {
      const { result, calls } = await check(() => endpointsAnswer([]), modelId);
      expect(result, modelId).toEqual({ outcome: "unknown_model" });
      expect(calls, modelId).toHaveLength(0);
    }
  });

  // #269-T03
  it("asks for the model itself when the name carries a variant such as :free", async () => {
    const { calls } = await check(
      () =>
        endpointsAnswer([{ supported_parameters: ["tools", "tool_choice"] }]),
      "vendor/model:free",
    );

    expect(calls[0]?.url).toBe(`${BASE}/models/vendor/model/endpoints`);
  });

  it("encodes the parts of the name it puts into the address", async () => {
    const { calls } = await check(
      () => endpointsAnswer([]),
      "ven+dor/mo.del_1",
    );

    expect(calls[0]?.url).toBe(`${BASE}/models/ven%2Bdor/mo.del_1/endpoints`);
  });
});

describe("what cannot be verified", () => {
  async function unverifiable(
    answer: () => Response | Promise<Response>,
  ): Promise<ModelCapabilityResult> {
    const { result } = await check(answer);
    expect(result.outcome).toBe("unverifiable");
    return result;
  }

  // #269-T04
  it("is unverifiable on a network error, without throwing", async () => {
    await unverifiable(() => {
      throw new TypeError("fetch failed: ECONNREFUSED 10.0.0.1:443");
    });
    await unverifiable(() => Promise.reject(new Error("socket hang up")));
  });

  // #269-T04
  it("is unverifiable when the provider does not answer in time", async () => {
    const result = await checkModelCapabilities({
      baseUrl: BASE,
      modelId: "vendor/model",
      timeoutMs: 20,
      log: () => undefined,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "TimeoutError")),
          );
        }),
    });

    expect(result.outcome).toBe("unverifiable");
  });

  // #269-T04
  it("is unverifiable when the answer is not JSON", async () => {
    await unverifiable(() => new Response("<html>gateway</html>"));
  });

  // #269-T04
  it("is unverifiable when the answer has an unexpected shape", async () => {
    for (const body of [
      "null",
      "[]",
      '{"data":null}',
      '{"data":{"endpoints":"all"}}',
      '{"data":{"endpoints":[{"supported_parameters":"tools"}]}}',
      '{"data":{"endpoints":[{"supported_parameters":[1,2]}]}}',
      '{"data":{"endpoints":[null]}}',
    ])
      await unverifiable(() => new Response(body));
  });

  // #269-T04
  it("is unverifiable when the body is larger than the limit, declared or streamed", async () => {
    const padding = "x".repeat(MODEL_METADATA_MAX_BYTES + 1);
    await unverifiable(
      () => new Response(JSON.stringify({ data: { endpoints: [], padding } })),
    );
    await unverifiable(
      () =>
        new Response("{}", {
          headers: { "content-length": String(MODEL_METADATA_MAX_BYTES + 1) },
        }),
    );
  });

  // #269-T04
  it("is unverifiable on a redirect, and does not follow it", async () => {
    const { result, calls } = await check(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test/models" },
        }),
    );

    expect(result.outcome).toBe("unverifiable");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  // #269-T04
  it("is unverifiable on a server error or a rate limit", async () => {
    await unverifiable(() => new Response("{}", { status: 500 }));
    await unverifiable(() => new Response("{}", { status: 429 }));
  });
});

describe("what the request carries and what is logged", () => {
  // #269-T10
  it("sends no credential, follows no redirect and has a time limit", async () => {
    const { calls } = await check(() => endpointsAnswer([]));

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init.credentials).toBeUndefined();
    expect(calls[0]?.init.body).toBeUndefined();
  });

  // #269-T10
  it("logs the model id and the outcome class only", async () => {
    const lines: string[] = [];
    const secretInError = "sk-or-v1-dummy-not-for-logs";
    await checkModelCapabilities({
      baseUrl: BASE,
      modelId: "vendor/model",
      log: (line) => lines.push(line),
      fetchImpl: () =>
        Promise.reject(new Error(`connect failed ${secretInError} to ${BASE}`)),
    });
    await checkModelCapabilities({
      baseUrl: BASE,
      modelId: "vendor/model",
      log: (line) => lines.push(line),
      fetchImpl: () =>
        Promise.resolve(
          endpointsAnswer([{ supported_parameters: ["tools", "tool_choice"] }]),
        ),
    });

    expect(lines).toEqual([
      "[llm] MODEL_CAPABILITY_CHECK: model=vendor/model outcome=unverifiable",
      "[llm] MODEL_CAPABILITY_CHECK: model=vendor/model outcome=supported",
    ]);
  });
});

describe("remembering a positive answer", () => {
  function setup(answers: Array<() => Response>) {
    let now = 1_000_000;
    const calls: string[] = [];
    const checker = createModelCapabilityChecker({
      baseUrl: () => BASE,
      ttlMs: 60_000,
      now: () => now,
      log: () => undefined,
      fetchImpl: (url) => {
        calls.push(url);
        const answer = answers[Math.min(calls.length, answers.length) - 1];
        return Promise.resolve(
          answer === undefined ? endpointsAnswer([]) : answer(),
        );
      },
    });
    return {
      checker,
      calls,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  const supported = () =>
    endpointsAnswer([{ supported_parameters: ["tools", "tool_choice"] }]);

  // #269-T08
  it("asks once for the same supported model within the cache time, and again after it", async () => {
    const app = setup([supported]);

    expect((await app.checker.check("vendor/model")).outcome).toBe("supported");
    expect((await app.checker.check("vendor/model")).outcome).toBe("supported");
    expect(app.calls).toHaveLength(1);

    app.advance(59_000);
    await app.checker.check("vendor/model");
    expect(app.calls).toHaveLength(1);

    app.advance(2_000);
    await app.checker.check("vendor/model");
    expect(app.calls).toHaveLength(2);
  });

  // #269-T08
  it("does not mix up two models", async () => {
    const app = setup([supported]);

    await app.checker.check("vendor/one");
    await app.checker.check("vendor/two");

    expect(app.calls).toHaveLength(2);
  });

  // #269-T08
  it("does not remember an unsupported, unknown or unverifiable answer", async () => {
    const app = setup([
      () => endpointsAnswer([{ supported_parameters: ["tools"] }]),
      () => new Response("{}", { status: 404 }),
      () => new Response("not json"),
      supported,
    ]);

    expect((await app.checker.check("vendor/model")).outcome).toBe(
      "unsupported",
    );
    expect((await app.checker.check("vendor/model")).outcome).toBe(
      "unknown_model",
    );
    expect((await app.checker.check("vendor/model")).outcome).toBe(
      "unverifiable",
    );
    expect((await app.checker.check("vendor/model")).outcome).toBe("supported");
    expect(app.calls).toHaveLength(4);
  });
});
