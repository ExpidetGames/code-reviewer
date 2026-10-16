// SPDX-License-Identifier: Apache-2.0

// Pins down the Dispatcher's side of the runner API (#322) against contracts/runner-api.v1.json: the
// feature list the version call answers equals the file's `KnownAppFeature`, the checks on the release
// body give the verdict of the schema, and the real answers of the release and the version call are
// valid documents of the file. The claim request is in runner-api-contract.integration.test.ts.
import { describe, expect, it } from "vitest";
import { APP_FEATURES } from "../../src/runner-api/contract.ts";
import {
  parseClaimRequest,
  parseReleaseRequest,
} from "../../src/runner-api/requests.ts";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../../src/test-support/runner-contract.ts";
import { startRunnerApiHarness } from "../../src/test-support/runner-api-harness.ts";

const contract = createContractValidator("runner-api.v1.json");
const CREDENTIAL = `crj_${"A".repeat(43)}`;

function expectValid(definition: string, document: unknown) {
  const { valid, errors } = contract.check(definition, document);
  expect({ valid, errors }).toStrictEqual({ valid: true, errors: "" });
}

describe("the lists of the app and of the file", () => {
  // #322-T11
  it("name the same app features", () => {
    expect([...APP_FEATURES].sort()).toStrictEqual(
      [...(readContract().$defs.KnownAppFeature?.enum ?? [])].sort(),
    );
  });
});

describe("the release body", () => {
  // #322-T07
  it("is judged like the contract", () => {
    const cases: Array<[string, unknown]> = [
      [
        "a full body",
        {
          credential: CREDENTIAL,
          reason: "launch_failed",
          retryAfterSeconds: 30,
        },
      ],
      ["no delay", { credential: CREDENTIAL, reason: "launch_failed" }],
      ["an unknown field", { credential: CREDENTIAL, reason: "x", more: 1 }],
      [
        "the lowest delay",
        { credential: CREDENTIAL, reason: "x", retryAfterSeconds: 1 },
      ],
      [
        "the highest delay",
        { credential: CREDENTIAL, reason: "x", retryAfterSeconds: 86400 },
      ],
      [
        "a delay of 0",
        { credential: CREDENTIAL, reason: "x", retryAfterSeconds: 0 },
      ],
      [
        "a delay over a day",
        { credential: CREDENTIAL, reason: "x", retryAfterSeconds: 86401 },
      ],
      [
        "a delay that is no integer",
        { credential: CREDENTIAL, reason: "x", retryAfterSeconds: 1.5 },
      ],
      [
        "a delay as text",
        { credential: CREDENTIAL, reason: "x", retryAfterSeconds: "30" },
      ],
      ["no credential", { reason: "x" }],
      ["no reason", { credential: CREDENTIAL }],
      [
        "a lease token as the credential",
        { credential: "lease-token-1234567", reason: "x" },
      ],
      [
        "a credential one character short",
        { credential: CREDENTIAL.slice(1), reason: "x" },
      ],
      [
        "a credential one character long",
        { credential: `${CREDENTIAL}A`, reason: "x" },
      ],
      ["a reason in capitals", { credential: CREDENTIAL, reason: "Launch" }],
      ["an empty reason", { credential: CREDENTIAL, reason: "" }],
      [
        "a reason of 64 characters",
        { credential: CREDENTIAL, reason: "a".repeat(64) },
      ],
      [
        "a reason of 65 characters",
        { credential: CREDENTIAL, reason: "a".repeat(65) },
      ],
      ["null", null],
      ["an array", []],
    ];

    for (const [name, body] of cases)
      expect({ name, ok: parseReleaseRequest(body).ok }).toStrictEqual({
        name,
        ok: contract.check("ReleaseRequest", body).valid,
      });
  });

  // #322-T12
  it("is read from the example of the file, and so is the claim request", () => {
    const examples = new Map(
      readExamples().map((e) => [e.definition, e.document]),
    );

    expect(parseReleaseRequest(examples.get("ReleaseRequest")).ok).toBe(true);
    expect(parseClaimRequest(examples.get("ClaimRequest"))).toMatchObject({
      ok: true,
      value: {
        jobId: "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10",
        maxRunning: 4,
      },
    });
  });
});

describe("the real answers", () => {
  // #322-T07
  it("of the release are valid ReleaseResponse documents, and so are its errors", async () => {
    const h = await startRunnerApiHarness({ limits: { maxAttempts: 2 } });
    const job = await h.enqueueNew();
    const first = (await h.claimedSplit({ jobId: job.id })).job.credential;
    const requeued = await h.release(job.id, {
      credential: first,
      reason: "launch_failed",
      retryAfterSeconds: 1,
    });
    h.clock.advance(2000);
    const second = (await h.claimedSplit({ jobId: job.id })).job.credential;
    const failed = await h.release(job.id, {
      credential: second,
      reason: "launch_failed",
    });
    const wrong = await h.release(job.id, {
      credential: CREDENTIAL,
      reason: "launch_failed",
    });
    const invalid = await h.release(job.id, { credential: "x", reason: "y" });
    const missing = await h.release(crypto.randomUUID(), {
      credential: CREDENTIAL,
      reason: "x",
    });
    const ended = await h.release(job.id, {
      credential: second,
      reason: "x",
    });

    expectValid("ReleaseResponse", await requeued.json());
    expectValid("ReleaseResponse", await failed.json());
    for (const [response, status] of [
      [wrong, 401],
      [invalid, 400],
      [missing, 404],
      [ended, 409],
    ] as const) {
      expect(response.status).toBe(status);
      expectValid("ErrorResponse", await response.json());
    }
  });

  // #364-T26
  it("of the job state call is a valid JobStateResponse, and its errors valid errors", async () => {
    const h = await startRunnerApiHarness();
    const job = await h.enqueueNew();

    const known = await h.jobState(job.id);
    const missing = await h.jobState(crypto.randomUUID());
    const refused = await h.jobState(job.id, { token: null });
    const invalid = await h.jobState("not-a-uuid");

    expect(known.status).toBe(200);
    expectValid("JobStateResponse", await known.json());
    for (const [response, status] of [
      [missing, 404],
      [refused, 401],
      [invalid, 400],
    ] as const) {
      expect(response.status).toBe(status);
      expectValid("ErrorResponse", await response.json());
    }
  });

  // #322-T11
  it("of the version call is a valid VersionResponse, and its refusal a valid error", async () => {
    const h = await startRunnerApiHarness();

    const ok = await h.version();
    const refused = await h.version({ token: null });

    expect(ok.status).toBe(200);
    expectValid("VersionResponse", await ok.json());
    expect(refused.status).toBe(401);
    expectValid("ErrorResponse", await refused.json());
  });
});
