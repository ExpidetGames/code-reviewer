// Pins down that the app and contracts/runner-api.v1.json describe the same API: what the app really
// answers (through the real handler) is valid against the file, what the app accepts from a runner
// is exactly what the file allows, and the lists the app keeps in TypeScript (error codes, commands)
// are the lists of the file. The runner checks the same file in runner/tests/contract.
import { describe, expect, it } from "vitest";
import { REVIEW_COMMANDS } from "../../src/integrations/types.ts";
import {
  RUNNER_API_ERROR_CODES,
  RUNNER_API_VERSION,
  RUNNER_ERROR_CODES,
} from "../../src/runner-api/contract.ts";
import {
  parseCompleteRequest,
  parseHeartbeatRequest,
} from "../../src/runner-api/requests.ts";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../../src/test-support/runner-contract.ts";
import {
  goodResult,
  startRunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const contract = createContractValidator();

function expectValid(definition: string, document: unknown) {
  const { valid, errors } = contract.check(definition, document);
  expect({ valid, errors }).toStrictEqual({ valid: true, errors: "" });
}

describe("the contract file", () => {
  it("is version 1 and the app speaks version 1", () => {
    expect(readContract().version).toBe(1);
    expect(RUNNER_API_VERSION).toBe(1);
  });

  it("lists the same runner error codes as the app's TypeScript list", () => {
    const listed = readContract().$defs.KnownRunnerErrorCode?.enum;

    expect([...RUNNER_ERROR_CODES].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  it("lists the same error codes of the API as the app's TypeScript list", () => {
    const listed = readContract().$defs.ApiErrorCode?.enum;

    expect([...RUNNER_API_ERROR_CODES].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  it("allows the commands the app can queue", () => {
    const listed = readContract().$defs.Command?.enum;

    expect([...REVIEW_COMMANDS].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  it.each(readExamples())(
    "has a valid example for $definition",
    ({ definition, document }) => {
      expectValid(definition, document);
    },
  );
});

describe("what the app answers", () => {
  // CR-28-T01
  it("answers a claim with a document that is valid against the contract", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    await h.enqueueNew({
      prNumber: 8,
      headSha: "b".repeat(40),
      command: "ask",
      args: "Why?",
      triggerKind: "comment",
    });

    const review = await h.claim();
    const ask = await h.claim();

    expect(review.status).toBe(200);
    const reviewBody = await review.json();
    expectValid("ClaimResponse", reviewBody);
    expect(Object.keys(reviewBody.job.input.git).sort()).toStrictEqual([
      "baseUrl",
      "botLogin",
      "provider",
      "token",
    ]);
    expect(reviewBody.job.input.git.token).toBe(h.issuedJobTokens()[0]);
    expect(typeof reviewBody.job.input.prUrl).toBe("string");
    expect(typeof reviewBody.job.leaseExpiresAt).toBe("string");
    expect(reviewBody.job.input.command).toBe("review");
    expect(reviewBody.job.input.env).toStrictEqual({});
    expect(reviewBody.job.input.llm.model).toBe("vendor/test-model");
    expectValid("ClaimResponse", await ask.json());
  });

  // CR-28-T02
  it("accepts a claim response that carries fields the contract does not know", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const body = await h.claimed();

    expectValid("ClaimResponse", {
      ...body,
      somethingNew: [1, 2],
      job: { ...body.job, priority: "high" },
    });
  });

  // CR-28-T03
  it("answers heartbeat and complete with documents that are valid against the contract", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const { job } = await h.claimed();

    expectValid(
      "HeartbeatResponse",
      await (await h.heartbeat(job.id, job.leaseToken)).json(),
    );
    const first = await h.complete(job.id, job.leaseToken);
    const repeated = await h.complete(job.id, job.leaseToken);
    expectValid("CompleteResponse", await first.json());
    expectValid("CompleteResponse", await repeated.json());
  });

  // CR-28-T03
  it("answers no job with 204 and no body", async () => {
    const h = await startRunnerApiHarness();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  // CR-28-T03
  it("gives every error the same form with a stable code and a message", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const { job } = await h.claimed();
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });
    await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    const unknown = "11111111-2222-4333-8444-555555555555";
    await h.complete(job.id, job.leaseToken);

    const answers = [
      [401, await h.claim({ token: "wrong" })],
      [400, await h.claim({ runnerId: "bad id" })],
      [400, await h.heartbeat("nope", "lease-token-value")],
      [400, await h.post("complete", job.id, "{")],
      [404, await h.heartbeat(unknown, "lease-token-value")],
      [409, await h.heartbeat(job.id, job.leaseToken)],
      [
        409,
        await h.complete(job.id, job.leaseToken, {
          ok: false,
          errorCode: "timeout",
        }),
      ],
      [
        413,
        await h.complete(job.id, job.leaseToken, {
          logTail: "x".repeat(100_000),
        }),
      ],
      [503, await h.claim()],
    ] as const;

    for (const [status, response] of answers) {
      expect(response.status).toBe(status);
      const body = await response.json();
      expectValid("ErrorResponse", body);
      expect(body.error.code).toMatch(/^RUNNER_[A-Z_]+$/);
    }
  });
});

describe("what the app accepts from a runner", () => {
  const TOKEN = "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33";
  const result = goodResult();

  const HEARTBEATS: Array<[string, unknown]> = [
    ["a lease token", { leaseToken: TOKEN }],
    ["extra fields", { leaseToken: TOKEN, extra: { a: 1 } }],
    ["no lease token", {}],
    ["a number as lease token", { leaseToken: 12345678 }],
    ["a lease token that is too short", { leaseToken: "short" }],
    ["a lease token at the shortest length", { leaseToken: "12345678" }],
    ["a lease token at the longest length", { leaseToken: "x".repeat(256) }],
    ["a lease token that is too long", { leaseToken: "x".repeat(257) }],
    ["null", null],
    ["an array", [TOKEN]],
  ];

  const COMPLETES: Array<[string, unknown]> = [
    ["a full successful result", { leaseToken: TOKEN, result }],
    [
      "a result with only the required fields",
      {
        leaseToken: TOKEN,
        result: { ok: true, durationMs: 0, errorCode: null, logTail: "" },
      },
    ],
    [
      "a failed result",
      {
        leaseToken: TOKEN,
        result: goodResult({
          ok: false,
          errorCode: "llm_auth",
          errorMessage: "refused",
        }),
      },
    ],
    [
      "a failed result with a code the app does not list",
      {
        leaseToken: TOKEN,
        result: goodResult({ ok: false, errorCode: "brand_new_failure" }),
      },
    ],
    [
      "a failed result without a code",
      { leaseToken: TOKEN, result: goodResult({ ok: false, errorCode: null }) },
    ],
    [
      "a good result with a code",
      { leaseToken: TOKEN, result: goodResult({ errorCode: "timeout" }) },
    ],
    [
      "an error code in capitals",
      {
        leaseToken: TOKEN,
        result: goodResult({ ok: false, errorCode: "TIMEOUT" }),
      },
    ],
    ["no lease token", { result }],
    ["no result", { leaseToken: TOKEN }],
    ["a result that is not an object", { leaseToken: TOKEN, result: "ok" }],
    [
      "no ok flag",
      {
        leaseToken: TOKEN,
        result: { durationMs: 1, errorCode: null, logTail: "" },
      },
    ],
    [
      "ok as text",
      {
        leaseToken: TOKEN,
        result: goodResult({ ok: "true" as unknown as boolean }),
      },
    ],
    [
      "a negative duration",
      { leaseToken: TOKEN, result: goodResult({ durationMs: -1 }) },
    ],
    [
      "a duration with decimals",
      { leaseToken: TOKEN, result: goodResult({ durationMs: 1.5 }) },
    ],
    [
      "a duration over the limit",
      { leaseToken: TOKEN, result: goodResult({ durationMs: 604_800_001 }) },
    ],
    [
      "no log tail",
      {
        leaseToken: TOKEN,
        result: { ok: true, durationMs: 1, errorCode: null },
      },
    ],
    [
      "a log tail of the longest length",
      { leaseToken: TOKEN, result: goodResult({ logTail: "x".repeat(8192) }) },
    ],
    [
      "a log tail that is too long",
      { leaseToken: TOKEN, result: goodResult({ logTail: "x".repeat(8193) }) },
    ],
    [
      "a log tail of many characters outside the basic plane that is within the limit",
      { leaseToken: TOKEN, result: goodResult({ logTail: "😀".repeat(5000) }) },
    ],
    [
      "a comment URL that is not a web address",
      {
        leaseToken: TOKEN,
        result: goodResult({ commentUrl: "ftp://example.test/x" }),
      },
    ],
    [
      "no comment URL",
      { leaseToken: TOKEN, result: goodResult({ commentUrl: null }) },
    ],
    [
      "an error message that is too long",
      {
        leaseToken: TOKEN,
        result: goodResult({
          ok: false,
          errorCode: "timeout",
          errorMessage: "x".repeat(2001),
        }),
      },
    ],
    [
      "usage without a model",
      {
        leaseToken: TOKEN,
        result: { ...result, usage: { ...result.usage, model: undefined } },
      },
    ],
    [
      "usage with a null model and cost",
      {
        leaseToken: TOKEN,
        result: {
          ...result,
          usage: { ...result.usage, model: null, costUsd: null },
        },
      },
    ],
    [
      "usage with a negative token count",
      {
        leaseToken: TOKEN,
        result: { ...result, usage: { ...result.usage, promptTokens: -1 } },
      },
    ],
    [
      "usage that is not an object",
      { leaseToken: TOKEN, result: { ...result, usage: "none" } },
    ],
    [
      "unknown fields in the result",
      { leaseToken: TOKEN, result: { ...result, extra: 1 } },
    ],
  ];

  it.each(HEARTBEATS)(
    "judges %s of a heartbeat like the contract",
    (_name, body) => {
      expect(parseHeartbeatRequest(body).ok).toBe(
        contract.check("HeartbeatRequest", body).valid,
      );
    },
  );

  it.each(COMPLETES)(
    "judges %s of a complete like the contract",
    (_name, body) => {
      expect(parseCompleteRequest(body).ok).toBe(
        contract.check("CompleteRequest", body).valid,
      );
    },
  );

  it("accepts the examples of the contract", () => {
    const examples = new Map(
      readExamples().map((example) => [example.definition, example.document]),
    );

    expect(parseHeartbeatRequest(examples.get("HeartbeatRequest")).ok).toBe(
      true,
    );
    expect(parseCompleteRequest(examples.get("CompleteRequest")).ok).toBe(true);
  });
});
