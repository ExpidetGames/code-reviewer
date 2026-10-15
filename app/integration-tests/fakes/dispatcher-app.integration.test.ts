// SPDX-License-Identifier: Apache-2.0

// The fake App (fakes/dispatcher-app) speaks the Dispatcher API and the Worker API from the contract
// examples, with scripted failures. Every answer is checked against the contract files, so the Worker
// (#323), the Dispatcher (#327) and the journeys (#332) can trust it.
import { afterEach, describe, expect, it } from "vitest";
import {
  startDispatcherAppFake,
  type DispatcherAppFake,
} from "../../../fakes/dispatcher-app/server.ts";
import { createContractValidator } from "../../src/test-support/runner-contract.ts";

const runner = createContractValidator("runner-api.v1.json");
const worker = createContractValidator("worker-api.v1.json");
const DISPATCHER_TOKEN = "fake-dispatcher-token";
const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";

const started: DispatcherAppFake[] = [];
async function start(
  options: Parameters<typeof startDispatcherAppFake>[0] = {},
): Promise<DispatcherAppFake> {
  const fake = await startDispatcherAppFake({
    dispatcherToken: DISPATCHER_TOKEN,
    ...options,
  });
  started.push(fake);
  return fake;
}
afterEach(async () => {
  await Promise.all(started.splice(0).map((fake) => fake.close()));
});

function dispatcherCall(
  fake: DispatcherAppFake,
  method: string,
  path: string,
  body?: unknown,
  token = DISPATCHER_TOKEN,
) {
  return fetch(`${fake.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-runner-id": "pool-a",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function workerCall(
  fake: DispatcherAppFake,
  method: string,
  path: string,
  credential: string,
  body?: unknown,
) {
  return fetch(`${fake.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function claim(
  fake: DispatcherAppFake,
  body: unknown = {
    features: ["worker_credential"],
    jobId: JOB,
    maxRunning: 2,
  },
) {
  const response = await dispatcherCall(
    fake,
    "POST",
    "/api/runners/v1/claim",
    body,
  );
  const job =
    response.status === 200
      ? ((await response.json()) as { job: { id: string; credential: string } })
      : null;
  return { response, job };
}

function valid(
  validator: typeof runner,
  definition: string,
  document: unknown,
) {
  const { valid: ok, errors } = validator.check(definition, document);
  expect({ ok, errors }).toStrictEqual({ ok: true, errors: "" });
}

const RESULT = {
  result: {
    ok: true,
    durationMs: 1200,
    commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1",
  },
};

describe("the fake App", () => {
  // #318-T08
  it("serves a scripted claim, fetch, heartbeat and result that match the schemas", async () => {
    const fake = await start();
    fake.enqueue({ id: JOB });

    const { response, job } = await claim(fake);
    expect(response.status).toBe(200);
    valid(runner, "SplitClaimResponse", job);
    expect(JSON.stringify(job)).not.toContain('"input"');
    const credential = job?.job.credential ?? "";

    const details = await workerCall(
      fake,
      "GET",
      `/api/workers/v1/jobs/${JOB}?features=dynamic_capabilities`,
      credential,
    );
    expect(details.status).toBe(200);
    valid(worker, "WorkerJobDetailsResponse", await details.json());

    const beat = await workerCall(
      fake,
      "POST",
      `/api/workers/v1/jobs/${JOB}/heartbeat`,
      credential,
      {},
    );
    expect(beat.status).toBe(200);
    valid(worker, "WorkerHeartbeatResponse", await beat.json());

    const result = await workerCall(
      fake,
      "POST",
      `/api/workers/v1/jobs/${JOB}/result`,
      credential,
      RESULT,
    );
    expect(result.status).toBe(200);
    valid(worker, "WorkerResultResponse", await result.json());
    expect(fake.results(JOB)).toStrictEqual([RESULT.result]);

    const again = await workerCall(
      fake,
      "POST",
      `/api/workers/v1/jobs/${JOB}/result`,
      credential,
      RESULT,
    );
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { alreadyCompleted: boolean }).alreadyCompleted,
    ).toBe(true);
  });

  // #318-T08
  it("answers 204 when nothing can be claimed and honours the pool cap", async () => {
    const fake = await start();

    expect((await claim(fake)).response.status).toBe(204);

    fake.enqueue({ id: JOB });
    expect(
      (await claim(fake, { features: ["worker_credential"], maxRunning: 1 }))
        .response.status,
    ).toBe(200);
    fake.enqueue({ id: "11111111-1111-4111-8111-111111111111" });
    expect(
      (await claim(fake, { features: ["worker_credential"], maxRunning: 1 }))
        .response.status,
    ).toBe(204);
  });

  // #318-T08
  it("answers a claim without the feature with the legacy shape, input included", async () => {
    const fake = await start();
    fake.enqueue({ id: JOB });

    const { response, job } = await claim(fake, { engines: ["pr-agent"] });

    expect(response.status).toBe(200);
    valid(runner, "ClaimResponse", job);
  });

  // #318-T08
  it("scripts a 5xx and then recovers, the same way every time", async () => {
    async function run(): Promise<number[]> {
      const fake = await start();
      fake.enqueue({ id: JOB });
      const { job } = await claim(fake);
      const credential = job?.job.credential ?? "";
      fake.script("heartbeat", [
        { status: 503, retryAfterSeconds: 7 },
        { status: 500 },
      ]);
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await workerCall(
          fake,
          "POST",
          `/api/workers/v1/jobs/${JOB}/heartbeat`,
          credential,
          {},
        );
        statuses.push(response.status);
        if (response.status === 503) {
          expect(response.headers.get("retry-after")).toBe("7");
          valid(worker, "WorkerErrorResponse", await response.json());
        }
      }
      return statuses;
    }

    expect(await run()).toStrictEqual([503, 500, 200]);
    expect(await run()).toStrictEqual([503, 500, 200]);
  });

  // #318-T08
  it("loses the lease on demand: heartbeat and result answer 409", async () => {
    const fake = await start();
    fake.enqueue({ id: JOB });
    const { job } = await claim(fake);
    const credential = job?.job.credential ?? "";

    fake.loseLease(JOB);

    const beat = await workerCall(
      fake,
      "POST",
      `/api/workers/v1/jobs/${JOB}/heartbeat`,
      credential,
      {},
    );
    expect(beat.status).toBe(409);
    const body = await beat.json();
    valid(worker, "WorkerErrorResponse", body);
    expect((body as { error: { code: string } }).error.code).toBe(
      "RUNNER_LEASE_LOST",
    );
    const result = await workerCall(
      fake,
      "POST",
      `/api/workers/v1/jobs/${JOB}/result`,
      credential,
      RESULT,
    );
    expect(result.status).toBe(409);
  });

  // #318-T08
  it("waits as scripted, through the injected sleeper (no real delay)", async () => {
    const waited: number[] = [];
    const fake = await start({ sleep: async (ms) => void waited.push(ms) });
    fake.enqueue({ id: JOB });
    fake.script("claim", [{ delayMs: 1500 }]);

    expect((await claim(fake)).response.status).toBe(200);
    expect(waited).toStrictEqual([1500]);
  });

  // #318-T08
  it("keeps the two credentials apart", async () => {
    const fake = await start();
    fake.enqueue({ id: JOB });
    const { job } = await claim(fake);
    const credential = job?.job.credential ?? "";

    const dispatcherOnWorker = await workerCall(
      fake,
      "GET",
      `/api/workers/v1/jobs/${JOB}`,
      DISPATCHER_TOKEN,
    );
    expect(dispatcherOnWorker.status).toBe(401);
    expect(
      ((await dispatcherOnWorker.json()) as { error: { code: string } }).error
        .code,
    ).toBe("WORKER_CREDENTIAL_INVALID");

    const workerOnClaim = await dispatcherCall(
      fake,
      "POST",
      "/api/runners/v1/claim",
      { jobId: JOB },
      credential,
    );
    expect(workerOnClaim.status).toBe(401);
    expect(
      ((await workerOnClaim.json()) as { error: { code: string } }).error.code,
    ).toBe("RUNNER_UNAUTHORIZED");

    const other = await workerCall(
      fake,
      "GET",
      `/api/workers/v1/jobs/11111111-1111-4111-8111-111111111111`,
      credential,
    );
    expect(other.status).toBe(401);
  });

  // #318-T08
  it("serves release and version to the Dispatcher", async () => {
    const fake = await start();
    fake.enqueue({ id: JOB });
    const { job } = await claim(fake);

    const release = await dispatcherCall(
      fake,
      "POST",
      `/api/runners/v1/jobs/${JOB}/release`,
      {
        credential: job?.job.credential,
        reason: "launch_failed",
      },
    );
    expect(release.status).toBe(200);
    valid(runner, "ReleaseResponse", await release.json());

    const version = await dispatcherCall(
      fake,
      "GET",
      "/api/runners/v1/version",
    );
    expect(version.status).toBe(200);
    valid(runner, "VersionResponse", await version.json());

    // Released: claimable again, with a new credential.
    const second = await claim(fake);
    expect(second.response.status).toBe(200);
    expect(second.job?.job.credential).not.toBe(job?.job.credential);
  });

  // #324-T11
  it("serves version to a Worker with its job credential and its job id, and to nobody else", async () => {
    const fake = await start();
    fake.enqueue({ id: JOB });
    const { job } = await claim(fake);
    const credential = job?.job.credential ?? "";
    const path = "/api/runners/v1/version";

    const own = await workerCall(
      fake,
      "GET",
      `${path}?jobId=${JOB}`,
      credential,
    );
    expect(own.status).toBe(200);
    valid(runner, "VersionResponse", await own.json());

    // The credential alone, another job id, an unknown job and a wrong credential are all refused.
    for (const [query, token] of [
      ["", credential],
      ["?jobId=11111111-1111-4111-8111-111111111111", credential],
      [`?jobId=${JOB}`, `crj_${"Z".repeat(43)}`],
    ] as const) {
      const refused = await workerCall(fake, "GET", `${path}${query}`, token);
      expect(refused.status, `${query} ${token}`).toBe(401);
    }
    // The dispatcher credential still needs no job id.
    expect((await dispatcherCall(fake, "GET", path)).status).toBe(200);
    // The request log names the job of the Worker's call and holds no credential.
    const logged = fake.requests().filter((entry) => entry.route === "version");
    expect(logged.some((entry) => entry.jobId === JOB)).toBe(true);
    expect(JSON.stringify(fake.requests())).not.toContain(credential);
  });

  // #318-T08
  it("never records a credential in its request log", async () => {
    const fake = await start();
    fake.enqueue({ id: JOB });
    const { job } = await claim(fake);
    await workerCall(
      fake,
      "GET",
      `/api/workers/v1/jobs/${JOB}`,
      job?.job.credential ?? "",
    );

    const log = JSON.stringify(fake.requests());

    expect(log).not.toContain(job?.job.credential ?? "x");
    expect(log).not.toContain(DISPATCHER_TOKEN);
    expect(fake.requests().map((r) => [r.route, r.status])).toStrictEqual([
      ["claim", 200],
      ["job", 200],
    ]);
  });

  // #318-T08
  it("is scripted and read over HTTP too, for the suites that run it as a process", async () => {
    const fake = await start();
    const control = (path: string, method = "GET", body?: unknown) =>
      fetch(`${fake.url}/__fake/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    expect((await control("health")).status).toBe(200);
    expect((await control("enqueue", "POST", { id: JOB })).status).toBe(200);
    expect(
      (
        await control("script", "POST", {
          route: "claim",
          steps: [{ status: 500 }],
        })
      ).status,
    ).toBe(200);

    expect((await claim(fake)).response.status).toBe(500);
    const { job } = await claim(fake);
    expect(job?.job.id).toBe(JOB);

    expect((await control("lose-lease", "POST", { jobId: JOB })).status).toBe(
      200,
    );
    const requests = (await (await control("requests")).json()) as Array<{
      route: string;
    }>;
    expect(requests.map((r) => r.route)).toStrictEqual(["claim", "claim"]);

    expect((await control("reset", "POST")).status).toBe(200);
    expect(
      ((await (await control("requests")).json()) as unknown[]).length,
    ).toBe(0);
  });

  // #318-T08
  it("refuses a malformed request with the contract's error", async () => {
    const fake = await start();

    const response = await dispatcherCall(
      fake,
      "POST",
      "/api/runners/v1/claim",
      { maxRunning: 0 },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    valid(runner, "ErrorResponse", body);
    expect((body as { error: { code: string } }).error.code).toBe(
      "RUNNER_REQUEST_INVALID",
    );
  });
});
