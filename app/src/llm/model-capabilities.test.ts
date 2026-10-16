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
  context_length?: number | null;
  pricing?: { prompt?: unknown; completion?: unknown };
  supports_tool_choice?: { required?: boolean };
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
        toolChoiceRequired: true,
        responseFormat: true,
        structuredOutputs: true,
        maxCompletionTokens: 32_768,
        smallestCompletionTokens: 32_768,
        contextLength: null,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
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
        toolChoiceRequired: false,
        responseFormat: true,
        structuredOutputs: false,
        maxCompletionTokens: null,
        smallestCompletionTokens: null,
        contextLength: null,
        inputUsdPerMtok: null,
        outputUsdPerMtok: null,
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
    for (const modelId of [
      "just-a-name",
      "a/b/c",
      "/slug",
      "author/",
      // Path traversal: `fetch` would turn these into another route of the provider.
      "vendor/.",
      "vendor/..",
      "vendor/..:free",
      "./model",
      "../model",
      "..",
    ]) {
      const { result, calls } = await check(() => endpointsAnswer([]), modelId);
      expect(result, modelId).toEqual({ outcome: "unknown_model" });
      expect(calls, modelId).toHaveLength(0);
    }
  });

  // #269-T03
  // #269-T03
  it("makes no request and logs no raw text for a name the settings would refuse", async () => {
    const lines: string[] = [];
    const { fetchImpl, calls } = recordingFetch(() => endpointsAnswer([]));
    const hostile = "vendor/model\n[llm] FORGED: outcome=supported";

    const result = await checkModelCapabilities({
      baseUrl: BASE,
      modelId: hostile,
      fetchImpl,
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({ outcome: "unknown_model" });
    expect(calls).toHaveLength(0);
    expect(lines).toEqual([
      "[llm] MODEL_CAPABILITY_CHECK: model=(invalid) outcome=unknown_model",
    ]);
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

const TOOLS = ["tools", "tool_choice"];

// What the descriptor of a job is built from (#279): the endpoints a run could be routed to are the
// ones that list tool calling, so the window, the output limit and the prices are read from them and
// from nothing else, and always at the bound a reservation needs (the smallest window and limit, the
// highest price).
describe("reading window, output limit and prices for a job (#279)", () => {
  // #279-T01
  it("reads the context window, the output limit and the unit prices per million tokens", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        {
          supported_parameters: TOOLS,
          context_length: 1_048_576,
          max_completion_tokens: 393_216,
          pricing: { prompt: "0.00000002016", completion: "0.000000891" },
        },
      ]),
    );

    expect(result).toMatchObject({
      outcome: "supported",
      capabilities: {
        contextLength: 1_048_576,
        smallestCompletionTokens: 393_216,
        inputUsdPerMtok: "0.02016",
        outputUsdPerMtok: "0.891",
      },
    });
  });

  // #279-T01
  it("takes the smallest window and limit and the highest prices of the endpoints that can serve the run", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        {
          supported_parameters: TOOLS,
          context_length: 1_048_576,
          max_completion_tokens: 943_718,
          pricing: { prompt: "0.0000001", completion: "0.0000024" },
        },
        {
          supported_parameters: TOOLS,
          context_length: 131_072,
          max_completion_tokens: 8_192,
          pricing: { prompt: "0.0000006", completion: "0.0000004" },
        },
        {
          // Not an endpoint a run can use: it has no tool calling, so it sets no bound.
          supported_parameters: ["temperature"],
          context_length: 1_000,
          max_completion_tokens: 10,
          pricing: { prompt: "0.001", completion: "0.001" },
        },
      ]),
    );

    expect(result).toMatchObject({
      outcome: "supported",
      capabilities: {
        contextLength: 131_072,
        smallestCompletionTokens: 8_192,
        maxCompletionTokens: 943_718,
        inputUsdPerMtok: "0.6",
        outputUsdPerMtok: "2.4",
      },
    });
  });

  // #279-T01
  it("does not count an endpoint that says it cannot force a tool choice", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        {
          supported_parameters: TOOLS,
          supports_tool_choice: { required: false },
          pricing: { prompt: "0.001", completion: "0.001" },
        },
        {
          supported_parameters: TOOLS,
          supports_tool_choice: { required: true },
          pricing: { prompt: "0.0000001", completion: "0.0000002" },
        },
      ]),
    );

    expect(result).toMatchObject({
      outcome: "supported",
      capabilities: {
        toolChoiceRequired: true,
        inputUsdPerMtok: "0.1",
        outputUsdPerMtok: "0.2",
      },
    });
  });

  // #279-T06
  it("is unsupported when no endpoint can force a tool choice", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        {
          supported_parameters: TOOLS,
          supports_tool_choice: { required: false },
        },
      ]),
    );

    expect(result).toMatchObject({
      outcome: "unsupported",
      capabilities: { toolChoiceRequired: false },
    });
  });

  // #279: a price that cannot be read exactly is no price; the runner then refuses to run the model.
  it.each([
    ["a missing price", undefined],
    ["a negative price (a router)", "-1"],
    ["a price in exponent form", "1e-7"],
    ["a price that is not text", 0.0000001],
    ["a price too large to be a unit price", "9999999"],
    ["an empty price", ""],
  ])("reads no unit prices when one is %s", async (_name, bad) => {
    const { result } = await check(() =>
      endpointsAnswer([
        {
          supported_parameters: TOOLS,
          pricing: { prompt: "0.0000001", completion: "0.0000002" },
        },
        {
          supported_parameters: TOOLS,
          pricing: { prompt: bad, completion: "0.0000002" },
        },
      ]),
    );

    expect(result).toMatchObject({
      outcome: "supported",
      capabilities: { inputUsdPerMtok: null, outputUsdPerMtok: null },
    });
  });

  it("keeps a free model's zero price", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        {
          supported_parameters: TOOLS,
          pricing: { prompt: "0", completion: "0.0" },
        },
      ]),
    );

    expect(result).toMatchObject({
      capabilities: { inputUsdPerMtok: "0", outputUsdPerMtok: "0" },
    });
  });

  it("reads no window when an endpoint states none", async () => {
    const { result } = await check(() =>
      endpointsAnswer([
        { supported_parameters: TOOLS, context_length: 100_000 },
        { supported_parameters: TOOLS, context_length: null },
      ]),
    );

    expect(result).toMatchObject({ capabilities: { contextLength: null } });
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

describe("the claim path of the checker (#280)", () => {
  function setup(answers: Array<() => Response>) {
    let now = 1_000_000;
    const calls: string[] = [];
    const lines: string[] = [];
    const checker = createModelCapabilityChecker({
      baseUrl: () => BASE,
      ttlMs: 60_000,
      now: () => now,
      log: (line) => lines.push(line),
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
      lines,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  const withWindow = (contextLength: number) => () =>
    endpointsAnswer([
      {
        supported_parameters: ["tools", "tool_choice"],
        context_length: contextLength,
      },
    ]);
  const unreachable = () => new Response("down", { status: 503 });

  // #280-T09
  it("remembers an answer that is not supported for a short time, so a provider outage costs one wait, not one per claim", async () => {
    const app = setup([unreachable, withWindow(200_000)]);

    for (let i = 0; i < 3; i += 1)
      expect(
        (await app.checker.check("vendor/model", { forClaim: true })).outcome,
      ).toBe("unverifiable");
    expect(app.calls).toHaveLength(1);

    app.advance(46_000);
    expect(
      (await app.checker.check("vendor/model", { forClaim: true })).outcome,
    ).toBe("supported");
    expect(app.calls).toHaveLength(2);
  });

  // #280-T09
  it("does not remember it for a settings save, which must see the provider as it is now", async () => {
    const app = setup([unreachable, withWindow(200_000)]);

    expect((await app.checker.check("vendor/model")).outcome).toBe(
      "unverifiable",
    );
    expect((await app.checker.check("vendor/model")).outcome).toBe("supported");
    expect(app.calls).toHaveLength(2);
  });

  // #280-T09
  it("keeps the last context window it read much longer than a supported answer, for when a fresh read fails", async () => {
    const app = setup([withWindow(200_000), unreachable]);
    expect(app.checker.lastKnownContextLength?.("vendor/model")).toBeNull();

    await app.checker.check("vendor/model", { forClaim: true });
    app.advance(10 * 60_000);
    expect(
      (await app.checker.check("vendor/model", { forClaim: true })).outcome,
    ).toBe("unverifiable");

    expect(app.checker.lastKnownContextLength?.("vendor/model")).toBe(200_000);
    app.advance(23 * 60 * 60_000);
    expect(app.checker.lastKnownContextLength?.("vendor/model")).toBe(200_000);
    app.advance(2 * 60 * 60_000);
    expect(app.checker.lastKnownContextLength?.("vendor/model")).toBeNull();
  });

  // #280-T09
  it("replaces the last known window with a newer read, and does not invent one when the metadata states none", async () => {
    const app = setup([
      withWindow(200_000),
      () =>
        endpointsAnswer([{ supported_parameters: ["tools", "tool_choice"] }]),
      withWindow(64_000),
    ]);

    await app.checker.check("vendor/model", { forClaim: true });
    app.advance(61_000);
    await app.checker.check("vendor/model", { forClaim: true });
    expect(app.checker.lastKnownContextLength?.("vendor/model")).toBe(200_000);

    app.advance(61_000);
    await app.checker.check("vendor/model", { forClaim: true });
    expect(app.checker.lastKnownContextLength?.("vendor/model")).toBe(64_000);
  });

  // #280-T08
  it("logs what it is told to instead of the model id", async () => {
    const app = setup([withWindow(200_000)]);

    await app.checker.check("vendor/model", { logAs: "tier=high" });

    expect(app.lines).toEqual([
      "[llm] MODEL_CAPABILITY_CHECK: model=tier=high outcome=supported",
    ]);
  });
});
