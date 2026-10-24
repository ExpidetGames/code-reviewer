// SPDX-License-Identifier: LicenseRef-Proprietary

// The stop call of the dispatch webhook against a real database and a stand-in for the Dispatcher (#487): which jobs get
// a signed `POST /stop` (only those whose wake-up a Dispatcher acknowledged), what the call is, how a failure is
// repeated and logged, and that nothing here ever throws. On SQLite and, when TEST_DATABASE_URL is set, on Postgres.
import type { Kysely } from "kysely";
import { describe, expect, it as vitestIt } from "vitest";
import type { DispatchStop } from "../contracts/dispatch-webhook.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  createFakeDispatchReceiver,
  type ReceiverReply,
} from "../test-support/fake-dispatch-receiver.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";
import type { WebhookDispatchConfig } from "./config.ts";
import { decideOutcome } from "./outcome.ts";
import { createStopService, STOP_RETRY_DELAYS_MS } from "./stop.ts";

const CURRENT = {
  kid: "k2",
  secret: "example-dispatch-secret-current-00000000",
};
const PREVIOUS = {
  kid: "k1",
  secret: "example-dispatch-secret-previous-0000000",
};
const BYPASS = "example-bypass-token-0000000000000000";

const webhookConfig: WebhookDispatchConfig = {
  mode: "webhook",
  url: "https://dispatcher.example.test/dispatch",
  currentKey: CURRENT,
  previousKey: PREVIOUS,
  bypassToken: BYPASS,
};

const stopping: ReceiverReply = {
  status: 202,
  body: JSON.stringify({ version: 1, status: "stopping" }),
};
const noVm: ReceiverReply = {
  status: 200,
  body: JSON.stringify({ version: 1, status: "ignored", reason: "no_vm" }),
};

const databases: Array<
  [string, (() => Promise<Kysely<Database>>) | undefined]
> = [
  ["SQLite", undefined],
  [
    "Postgres",
    hasPostgres()
      ? async () => (await createPostgresTestDatabase({ poolMax: 12 })).db
      : undefined,
  ],
];

describe.each(databases)("the stop call on %s", (name, open) => {
  const it =
    name === "Postgres" && open === undefined ? vitestIt.skip : vitestIt;

  async function setup(config: WebhookDispatchConfig = webhookConfig) {
    const database = await open?.();
    const fixture = await createJobQueueFixture(
      database === undefined ? {} : { database },
    );
    const receiver = createFakeDispatchReceiver({
      keys: [CURRENT, PREVIOUS],
      now: fixture.clock.now,
    });
    const warnings: string[] = [];
    const pauses: number[] = [];
    let ids = 0;
    const service = createStopService({
      db: fixture.db,
      config,
      fetch: receiver.fetch,
      now: fixture.clock.now,
      newId: () =>
        `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, "0")}`,
      timeoutMs: 40,
      sleep: (ms) => {
        pauses.push(ms);
        return Promise.resolve();
      },
      log: { warn: (line) => warnings.push(line) },
    });
    const dispatches = createJobDispatchesRepository(
      fixture.db,
      fixture.clock.now,
    );
    let pr = 0;
    /** A job whose wake-up a Dispatcher acknowledged (`acked`), or one whose row says it was never acknowledged. */
    async function job(row: "acked" | "pending" | "none") {
      pr += 1;
      const queued = await fixture.enqueueNew({
        prNumber: pr,
        prUrl: `https://github.test/acme/widgets/pull/${String(pr)}`,
        headSha: sha("a"),
      });
      if (row === "none") return queued.id;
      const at = fixture.clock.now();
      await dispatches.create(queued.id, at);
      const current = await dispatches.get(queued.id);
      if (current === undefined) throw new Error("no row");
      await dispatches.claimSend(queued.id, current.nextDispatchAt, at);
      if (row === "acked")
        await dispatches.record(
          queued.id,
          decideOutcome({ kind: "accepted" }, 0, at),
          at,
        );
      return queued.id;
    }
    const stopBody = (index = 0) =>
      receiver.received[index]?.body as unknown as DispatchStop | undefined;
    return { fixture, receiver, warnings, pauses, service, job, stopBody };
  }

  // #487-T06
  it("sends one signed stop to the Dispatcher's /stop for a job whose wake-up was acknowledged", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply(stopping);

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toHaveLength(1);
    const call = t.receiver.received[0];
    expect(call?.url).toBe("https://dispatcher.example.test/stop");
    expect(call?.verdict).toBe("ok");
    expect(call?.headers["x-dispatch-key-id"]).toBe(CURRENT.kid);
    expect(call?.headers["x-vercel-protection-bypass"]).toBe(BYPASS);
    expect(t.stopBody()).toEqual({
      version: 1,
      type: "job.stop",
      jobId: id,
      stopId: call?.headers["x-dispatch-id"],
      sentAt: t.fixture.clock.now().toISOString(),
    });
    expect(t.warnings).toEqual([]);
  });

  // #487-T06
  it("sends a stop for each of several jobs and one stop for a job named twice", async () => {
    const t = await setup();
    const first = await t.job("acked");
    const second = await t.job("acked");

    await t.service.stopJobs([first, second, first]);

    expect(
      t.receiver.received
        .map((call) => t.stopBody(t.receiver.received.indexOf(call))?.jobId)
        .sort(),
    ).toEqual([first, second].sort());
    const stopIds = t.receiver.received.map(
      (call) => call.headers["x-dispatch-id"],
    );
    expect(new Set(stopIds).size).toBe(2);
  });

  // #487-T08
  it("sends nothing for a job that no Dispatcher acknowledged, nor for a job without a dispatch", async () => {
    const t = await setup();
    const unacknowledged = await t.job("pending");
    const polled = await t.job("none");

    await t.service.stopJobs([
      unacknowledged,
      polled,
      "00000000-0000-4000-8000-0000000000ff",
    ]);

    expect(t.receiver.received).toEqual([]);
    expect(t.warnings).toEqual([]);
  });

  // #487-T07
  it("repeats a stop the Dispatcher could not take, with the same stop id, and logs the failure once", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply({ status: 503 }, { status: 500 }, { status: 502 });

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toHaveLength(1 + STOP_RETRY_DELAYS_MS.length);
    expect(
      new Set(t.receiver.received.map((call) => call.headers["x-dispatch-id"]))
        .size,
    ).toBe(1);
    expect(t.pauses).toEqual([...STOP_RETRY_DELAYS_MS]);
    expect(t.warnings).toEqual([`[dispatch] DISPATCH_STOP_FAILED job=${id}`]);
  });

  // #487-T07
  it("stops repeating when a repeat is taken, and logs nothing", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply({ status: 503 }, stopping);

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toHaveLength(2);
    expect(t.warnings).toEqual([]);
  });

  // #487-T07
  it("repeats a lost connection and a call that hangs, then logs the failure once", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply({ fails: "connection reset" }, "hang", { fails: "down" });

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toHaveLength(3);
    expect(t.warnings).toEqual([`[dispatch] DISPATCH_STOP_FAILED job=${id}`]);
  });

  // #487-T07
  it("waits the longer of its pause and the Retry-After of the Dispatcher, cut to 5 seconds", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply(
      { status: 503, headers: { "retry-after": "2" } },
      { status: 429, headers: { "retry-after": "600" } },
      stopping,
    );

    await t.service.stopJobs([id]);

    expect(t.pauses).toEqual([2_000, 5_000]);
    expect(t.warnings).toEqual([]);
  });

  // #487-T10
  it("logs a Dispatcher of the previous release (404) once and does not repeat", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply({ status: 404 });

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toHaveLength(1);
    expect(t.warnings).toEqual([
      `[dispatch] DISPATCH_STOP_UNSUPPORTED job=${id} status=404`,
    ]);
  });

  // #487-T07
  it("logs a refusal (a wrong key or secret) with its status and does not repeat", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply({ status: 401 });

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toHaveLength(1);
    expect(t.warnings).toEqual([
      `[dispatch] DISPATCH_STOP_REJECTED job=${id} status=401`,
    ]);
  });

  // #487-T07
  it("logs the code and the job id and nothing of the URL, the keys or the answer", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply({
      status: 500,
      body: `boom ${CURRENT.secret} ${BYPASS} https://dispatcher.example.test/stop`,
    });
    t.receiver.reply({ fails: `ECONNREFUSED https://dispatcher.example.test` });

    await t.service.stopJobs([id]);

    const logged = t.warnings.join("\n");
    for (const secret of [
      CURRENT.secret,
      PREVIOUS.secret,
      BYPASS,
      "dispatcher.example.test",
      CURRENT.kid,
    ])
      expect(logged).not.toContain(secret);
  });

  // #487-T07
  it("does not call a Dispatcher whose address does not end in /dispatch, and says so", async () => {
    const t = await setup({
      ...webhookConfig,
      url: "https://dispatcher.example.test/hooks/wake",
    });
    const id = await t.job("acked");

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toEqual([]);
    expect(t.warnings).toEqual([
      `[dispatch] DISPATCH_STOP_URL_INVALID job=${id}`,
    ]);
  });

  // #487-T07
  it("never throws when the database cannot be read", async () => {
    const t = await setup();
    const id = await t.job("acked");
    await t.fixture.db.destroy();

    await expect(t.service.stopJobs([id])).resolves.toBeUndefined();

    expect(t.warnings).toEqual([`[dispatch] DISPATCH_STOP_FAILED job=${id}`]);
    expect(t.receiver.received).toEqual([]);
  });

  // #487-T01
  it("takes the 200 of a Dispatcher that has no VM for the job as done", async () => {
    const t = await setup();
    const id = await t.job("acked");
    t.receiver.reply(noVm);

    await t.service.stopJobs([id]);

    expect(t.receiver.received).toHaveLength(1);
    expect(t.warnings).toEqual([]);
  });

  // #487-T07
  it("keeps going with the other jobs when one of them fails", async () => {
    const t = await setup();
    const first = await t.job("acked");
    const second = await t.job("acked");
    t.receiver.reply({ status: 404 }, stopping);
    // The default answer after the script is 202; the first call is the 404.

    await t.service.stopJobs([first, second]);

    expect(t.receiver.received).toHaveLength(2);
    expect(t.warnings).toHaveLength(1);
  });
});
