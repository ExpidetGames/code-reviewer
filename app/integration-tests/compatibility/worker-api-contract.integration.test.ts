// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the app and contracts/worker-api.v1.json (with the split claim of runner-api.v1.json)
// describe the same API (#320): what the app really answers through the real handlers is valid against
// the files, what it accepts from a Worker is what the file allows, and the lists it keeps in TypeScript
// equal the lists of the files. The runner (#323) and the Dispatcher (#327) check the same files.
import { describe, expect, it } from "vitest";
import {
  CLAIM_FEATURES,
  MAX_WORKER_FETCHES,
  RUNNER_API_ERROR_CODES,
} from "../../src/runner-api/contract.ts";
import {
  parseWorkerFeatures,
  parseWorkerResultRequest,
} from "../../src/runner-api/requests.ts";
import {
  createContractValidator,
  readContract,
} from "../../src/test-support/runner-contract.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const runner = createContractValidator("runner-api.v1.json");
const worker = createContractValidator("worker-api.v1.json");

function expectValid(
  validator: ReturnType<typeof createContractValidator>,
  definition: string,
  document: unknown,
) {
  const { valid, errors } = validator.check(definition, document);
  expect({ valid, errors }).toStrictEqual({ valid: true, errors: "" });
}

describe("the lists of the app and of the files", () => {
  // #320-T13
  it("name the same claim features and the same error codes", () => {
    expect([...CLAIM_FEATURES].sort()).toStrictEqual(
      [...(readContract().$defs.KnownClaimFeature?.enum ?? [])].sort(),
    );
    expect([...RUNNER_API_ERROR_CODES].sort()).toStrictEqual(
      [...(readContract().$defs.ApiErrorCode?.enum ?? [])].sort(),
    );
  });

  // #320-T13
  it("say that a claim allows three fetches, as the Worker API's description does", () => {
    expect(MAX_WORKER_FETCHES).toBe(3);
    expect(JSON.stringify(readContract("worker-api.v1.json"))).toContain(
      "at most three times per claim",
    );
  });
});

describe("the real answers of the Worker API", () => {
  /** A job claimed by a Dispatcher: its id and credential. */
  async function claimed(h: RunnerApiHarness) {
    await h.enqueueNew();
    return (await h.claimedSplit()).job;
  }

  // #320-T13
  it("are valid: the split claim, the details, the heartbeat and every result", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const splitResponse = await h.claimSplit();
    const split = await splitResponse.json();
    expectValid(runner, "SplitClaimResponse", split);
    const { id, credential } = split.job;

    const details = await h.worker.details(id, credential);
    expect(details.status).toBe(200);
    expectValid(worker, "WorkerJobDetailsResponse", await details.json());

    const beat = await h.worker.heartbeat(id, credential);
    expectValid(worker, "WorkerHeartbeatResponse", await beat.json());

    const first = await h.worker.result(id, credential);
    expectValid(worker, "WorkerResultResponse", await first.json());
    const repeated = await h.worker.result(id, credential);
    const repeatedBody = await repeated.json();
    expectValid(worker, "WorkerResultResponse", repeatedBody);
    expect(repeatedBody.alreadyCompleted).toBe(true);
  });

  // #320-T13
  it("are valid for a job that was given back and for a Dynamic job", async () => {
    const h = await startRunnerApiHarness({ projects: true });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });
    await h.enqueueNew();
    const { job } = await h.claimedSplit({ engines: ["pr-agent", "opencode"] });

    const details = await h.worker.details(job.id, job.credential);
    const body = await details.json();
    expectValid(worker, "WorkerJobDetailsResponse", body);
    expect(body.job.input.reviewKind).toBe("dynamic");

    const queued = await h.worker.result(job.id, job.credential, {
      ok: false,
      errorCode: "launch_failed",
    });
    const queuedBody = await queued.json();
    expectValid(worker, "WorkerResultResponse", queuedBody);
    expect(queuedBody.job.status).toBe("queued");
  });

  // #320-T13
  it("are valid for every error: 401, 400, 409, 413, 503 and 500", async () => {
    const h = await startRunnerApiHarness();
    const job = await claimed(h);
    const answers: Response[] = [
      await h.worker.details(job.id, `crj_${"A".repeat(43)}`),
      await h.worker.details("not-a-uuid", job.credential),
      await h.worker.result(job.id, job.credential, "{}"),
      await h.worker.result(job.id, job.credential, "x".repeat(70 * 1024)),
    ];
    // 409 conflict, 409 ended, 503, and 500.
    await h.worker.result(job.id, job.credential);
    answers.push(
      await h.worker.result(job.id, job.credential, { logTail: "other" }),
      await h.worker.heartbeat(job.id, job.credential),
    );
    const unavailable = await startRunnerApiHarness();
    const other = await claimed(unavailable);
    unavailable.fake.fail({
      pathIncludes: "/access_tokens",
      status: 503,
      times: 1,
    });
    answers.push(await unavailable.worker.details(other.id, other.credential));
    let broken = false;
    const failing = await startRunnerApiHarness({
      jobOptions: {
        optionsFor: async () => {
          if (broken) throw new Error("boom");
          return { env: {} };
        },
      },
    });
    const third = await claimed(failing);
    broken = true;
    answers.push(await failing.worker.details(third.id, third.credential));

    expect(answers.map((answer) => answer.status)).toStrictEqual([
      401, 400, 400, 413, 409, 409, 503, 500,
    ]);
    for (const answer of answers)
      expectValid(worker, "WorkerErrorResponse", await answer.json());
  });
});

describe("what the app accepts from a Worker", () => {
  const good = { result: goodResult() };
  const bodies: Array<[string, unknown]> = [
    ["a good result", good],
    [
      "a failed result",
      { result: goodResult({ ok: false, errorCode: "llm_timeout" }) },
    ],
    ["a result with an unknown top-level field", { ...good, extra: 1 }],
    ["no result", {}],
    ["a result that is not an object", { result: "ok" }],
    [
      "ok without a matching code",
      { result: goodResult({ ok: true, errorCode: "x" }) },
    ],
    [
      "a failure without a code",
      { result: goodResult({ ok: false, errorCode: null }) },
    ],
    ["a negative duration", { result: goodResult({ durationMs: -1 }) }],
    [
      "a comment url that is not http",
      { result: goodResult({ commentUrl: "ftp://x" }) },
    ],
    [
      "a log tail that is too long",
      { result: goodResult({ logTail: "x".repeat(8193) }) },
    ],
    ["not an object", []],
  ];

  // #320-T13
  it.each(bodies)(
    "gives the verdict of WorkerResultRequest for %s",
    (_name, body) => {
      const schema = worker.check("WorkerResultRequest", body).valid;

      expect(parseWorkerResultRequest(body).ok).toBe(schema);
    },
  );

  // #320-T13
  it("takes the features of the details call like the claim does: known names only", () => {
    expect(parseWorkerFeatures(null)).toStrictEqual([]);
    expect(parseWorkerFeatures("")).toStrictEqual([]);
    expect(parseWorkerFeatures("dynamic_capabilities")).toStrictEqual([
      "dynamic_capabilities",
    ]);
    expect(
      parseWorkerFeatures(
        "future_thing, dynamic_capabilities ,worker_credential",
      ),
    ).toStrictEqual(["dynamic_capabilities", "worker_credential"]);
  });

  // #424-T08: the details request is judged by the contract with or without the providers.
  it.each([
    ["nothing", {}, true],
    ["only the features", { features: "dynamic_capabilities,supersede" }, true],
    ["only the providers", { llmProviders: "openrouter" }, true],
    [
      "both",
      { features: "supersede", llmProviders: "openrouter,fakeai" },
      true,
    ],
    ["an uppercase provider", { llmProviders: "OpenRouter" }, false],
    [
      "a list with an empty name",
      { llmProviders: "openrouter,,fakeai" },
      false,
    ],
    ["a too short provider", { llmProviders: "a" }, false],
  ])("describes the details request with %s", (_name, query, valid) => {
    expect(worker.check("WorkerJobDetailsRequest", query).valid).toBe(valid);
  });
});
