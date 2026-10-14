// SPDX-License-Identifier: Apache-2.0

// #195: gate disable preserves running execution and serializes with lease transitions on PostgreSQL.
// Real queries are paused after execution through a Kysely observer, never replaced or mocked.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "./repositories/instance-settings-repository.ts";
import { createRunnerQueue } from "../jobs/runner-queue.ts";
import type { Database } from "./schema.ts";
import { createJobQueueFixture, sha } from "../test-support/jobs.ts";
import {
  connectPostgres,
  createPostgresTestDatabase,
  hasPostgres,
} from "../test-support/postgres-test-database.ts";

const describePostgres = hasPostgres() ? describe : describe.skip;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observeUpdate(match: (node: string) => boolean) {
  const reached = signal();
  const resume = signal();
  const queries = new Set<unknown>();
  let observed = false;
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      if (
        !observed &&
        args.node.kind === "UpdateQueryNode" &&
        match(JSON.stringify(args.node))
      ) {
        observed = true;
        queries.add(args.queryId);
      }
      return args.node;
    },
    async transformResult(args) {
      if (queries.has(args.queryId)) {
        reached.resolve();
        await resume.promise;
      }
      return args.result;
    },
  };
  return { plugin, reached: reached.promise, resume: resume.resolve };
}

function named(url: string, name: string) {
  const value = new URL(url);
  value.searchParams.set("application_name", name);
  return connectPostgres(value.toString());
}

async function lockWait(db: Kysely<Database>, waiter: string, holder: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { rows } = await sql<{ wait_event: string; holder: string }>`
      select waiter.wait_event, holder.application_name as holder
      from pg_stat_activity waiter join pg_stat_activity holder
        on holder.pid = any(pg_blocking_pids(waiter.pid))
      where waiter.application_name = ${waiter} and waiter.wait_event_type = 'Lock'`.execute(
      db,
    );
    if (rows.length > 0) {
      expect(rows.map((row) => row.holder)).toEqual([holder]);
      expect(rows[0]?.wait_event).toBe("advisory");
      return;
    }
    if (Date.now() >= deadline)
      throw new Error("The transition never waited for the gate holder.");
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function enabledFixture() {
  const postgres = await createPostgresTestDatabase();
  const fixture = await createJobQueueFixture({ database: postgres.db });
  await createInstanceSettingsRepository(postgres.db, fixture.clock.now).set(
    "dynamic_review",
    { enabled: true },
    null,
  );
  return { postgres, fixture };
}

describePostgres("disabling Dynamic Review with running work", () => {
  // #195-T04: reproduce the window after the queued drain and before the old running drain.
  it.each([
    ["release", 0],
    ["release", 2],
    ["expiry", 0],
    ["expiry", 2],
  ] as const)(
    "serializes disable with %s at attempt %s and never reclaims the Dynamic job",
    async (transition, attempts) => {
      const { postgres, fixture } = await enabledFixture();
      const job = await fixture.enqueueNew({ reviewKind: "dynamic" });
      const claim = await fixture.queue.claimNext("runner", ["opencode"]);
      expect(claim?.job.id).toBe(job.id);
      await postgres.db
        .updateTable("jobs")
        .set({ attempts })
        .where("id", "=", job.id)
        .execute();
      // The drain holds this queued row too. A transition that locks rows before the gate would
      // wait on the row (or deadlock), so the advisory-wait assertion proves the first lock.
      const waiting = await fixture.enqueueNew({
        reviewKind: "dynamic",
        prNumber: 8,
      });
      if (transition === "expiry") fixture.clock.advance(3 * 60 * 1000);
      const observer = observeUpdate(
        (node) =>
          node.includes('"value":"cancelled"') &&
          node.includes('"value":"dynamic_review_disabled"'),
      );
      const drain = named(postgres.url, "r3_drain");
      const runner = named(postgres.url, "r3_runner");
      const disable = createInstanceSettingsRepository(
        drain.db.withPlugin(observer.plugin),
        fixture.clock.now,
      ).set("dynamic_review", { enabled: false }, null);
      await Promise.race([
        observer.reached,
        disable.then(() => {
          throw new Error("The queued drain was not observed.");
        }),
      ]);
      const queue = createRunnerQueue(runner.db, { now: fixture.clock.now });
      const pending =
        transition === "release"
          ? queue.release(job.id, claim!.leaseToken, "runner_shutdown", {
              retryAt: new Date(fixture.clock.now().getTime() + 15 * 60 * 1000),
            })
          : queue.expireStaleJobs();
      let results: PromiseSettledResult<unknown>[] = [];
      try {
        await lockWait(postgres.db, "r3_runner", "r3_drain");
      } finally {
        observer.resume();
        results = await Promise.allSettled([disable, pending]);
      }
      expect(results.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      expect(await pending).toMatchObject(
        transition === "expiry"
          ? { requeued: 0, leaseExpired: 1 }
          : { status: "failed", job: { errorCode: "dynamic_review_disabled" } },
      );
      expect(await fixture.queue.get(job.id)).toMatchObject({
        status: "failed",
        errorCode: "dynamic_review_disabled",
        attempts: attempts + 1,
      });
      expect(await fixture.queue.get(waiting.id)).toMatchObject({
        status: "cancelled",
        errorCode: "dynamic_review_disabled",
        attempts: 0,
      });
      expect(await queue.claimNext("next", ["opencode"])).toBeNull();
      const { rows } = await sql<{
        count: number;
      }>`select count(*)::int as count from jobs where review_kind = 'dynamic' and status in ('queued', 'running')`.execute(
        postgres.db,
      );
      expect(rows[0]?.count).toBe(0);
    },
  );

  // #195-T04: last-attempt expiry used to lock a different row before the drain's running pass.
  it("orders drain and expiry before row locks and avoids the opposing-order deadlock", async () => {
    const { postgres, fixture } = await enabledFixture();
    const retryable = await fixture.enqueueNew({
      reviewKind: "dynamic",
      prNumber: 7,
    });
    const last = await fixture.enqueueNew({
      reviewKind: "dynamic",
      prNumber: 8,
    });
    for (let i = 0; i < 2; i += 1)
      expect(
        await fixture.queue.claimNext(`runner-${String(i)}`, ["opencode"]),
      ).not.toBeNull();
    await postgres.db
      .updateTable("jobs")
      .set({ attempts: 2 })
      .where("id", "=", last.id)
      .execute();
    fixture.clock.advance(3 * 60 * 1000);
    const observer = observeUpdate(
      (node) =>
        node.includes('"value":"failed"') &&
        node.includes('"value":"lease_expired"'),
    );
    const expiry = named(postgres.url, "r3_expiry");
    const drain = named(postgres.url, "r3_deadlock_drain");
    const expire = createRunnerQueue(expiry.db.withPlugin(observer.plugin), {
      now: fixture.clock.now,
    }).expireStaleJobs();
    await Promise.race([
      observer.reached,
      expire.then(() => {
        throw new Error("The last-attempt expiry was not observed.");
      }),
    ]);
    const disable = createInstanceSettingsRepository(
      drain.db,
      fixture.clock.now,
    ).set("dynamic_review", { enabled: false }, null);
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await lockWait(postgres.db, "r3_deadlock_drain", "r3_expiry");
    } finally {
      observer.resume();
      results = await Promise.allSettled([expire, disable]);
    }
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await fixture.queue.get(last.id)).toMatchObject({
      status: "failed",
      errorCode: "lease_expired",
      attempts: 3,
    });
    expect(await fixture.queue.get(retryable.id)).toMatchObject({
      status: "cancelled",
      errorCode: "dynamic_review_disabled",
      attempts: 1,
    });
    expect(await fixture.queue.claimNext("next", ["opencode"])).toBeNull();
  });

  // #195-T02, #195-T04: a terminal row is not a stopped process. Keep the leased PR busy across disable.
  it("keeps the PR slot and heartbeat while a supervised Dynamic process is alive across disable", async () => {
    const { postgres, fixture } = await enabledFixture();
    const job = await fixture.enqueueNew({ reviewKind: "dynamic" });
    const claim = await fixture.queue.claimNext("runner", ["opencode"]);
    expect(claim?.job.id).toBe(job.id);
    const before = await postgres.db
      .selectFrom("jobs")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    const child = spawn(
      globalThis.process.execPath,
      [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); process.stdout.write('ready');",
      ],
      { env: { NODE_ENV: "test" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    try {
      await once(child.stdout, "data");
      const diff = await fixture.enqueueNew({
        reviewKind: "diff",
        headSha: sha("b"),
      });
      await createInstanceSettingsRepository(
        postgres.db,
        fixture.clock.now,
      ).set("dynamic_review", { enabled: false }, null);
      expect(child.exitCode).toBeNull();
      expect(
        await postgres.db
          .selectFrom("jobs")
          .selectAll()
          .where("id", "=", job.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      expect(
        await fixture.queue.claimNext("diff-runner", ["pr-agent"]),
      ).toBeNull();
      expect(
        await fixture.queue.heartbeat(job.id, claim!.leaseToken),
      ).toMatchObject({ status: "ok" });
      child.stdin.end();
      await exited;
      expect(child.exitCode).toBe(0);
      expect(
        await fixture.queue.complete(job.id, claim!.leaseToken, {
          ok: true,
          result: {},
        }),
      ).toMatchObject({ status: "completed" });
      expect(
        (await fixture.queue.claimNext("diff-runner", ["pr-agent"]))?.job.id,
      ).toBe(diff.id);
    } finally {
      child.stdin.end();
      await exited;
    }
  });
});
