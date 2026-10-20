// SPDX-License-Identifier: Apache-2.0

// The keys remembered for a job (#276): every key handed out for it stays remembered, so each is masked in the
// result after any number of rotations; the number is bounded; a row of the earlier format (one plain key) is
// still read; and what is stored is encrypted.
import { describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto/secret-box.ts";
import { createJobClaimedKeysRepository } from "../db/repositories/job-claimed-keys-repository.ts";
import { createJobQueueFixture } from "../test-support/jobs.ts";
import { CLAIMED_KEYS_PER_JOB, createClaimedKeys } from "./claimed-keys.ts";

const APP_SECRET = "claimed-keys-test-app-secret-0123456789-01";

async function start() {
  const fixture = await createJobQueueFixture({});
  const job = await fixture.enqueueNew();
  const keys = createClaimedKeys({
    db: fixture.db,
    appSecret: () => APP_SECRET,
    now: fixture.clock.now,
  });
  return { ...fixture, job, keys };
}

describe("the keys remembered for a job", () => {
  // #276-P3
  it("keeps every key handed out for it, so each stays masked after a rotation", async () => {
    const { job, keys } = await start();

    await keys.remember(job.id, "plain-key-one-0001");
    await keys.remember(job.id, "plain-key-two-0002");

    expect(await keys.keysOf(job.id)).toEqual([
      "plain-key-one-0001",
      "plain-key-two-0002",
    ]);
  });

  // #276-P3
  it("does not spend a place on a key it has already, so repeated fetches with one key keep it once", async () => {
    const { job, keys } = await start();

    for (let i = 0; i < 5; i += 1)
      await keys.remember(job.id, "plain-key-one-0001");

    expect(await keys.keysOf(job.id)).toEqual(["plain-key-one-0001"]);
  });

  // #276-P3
  it(`is bounded to ${String(CLAIMED_KEYS_PER_JOB)} keys per job and then forgets the oldest`, async () => {
    const { job, keys } = await start();

    for (const key of ["key-a-0001", "key-b-0002", "key-c-0003", "key-d-0004"])
      await keys.remember(job.id, key);

    const kept = await keys.keysOf(job.id);
    expect(kept).toHaveLength(CLAIMED_KEYS_PER_JOB);
    expect(CLAIMED_KEYS_PER_JOB).toBe(3);
    expect(kept).toEqual(["key-b-0002", "key-c-0003", "key-d-0004"]);
  });

  // #276-P3
  it("stores them encrypted in one row of the job, and keeps the keys of another job apart", async () => {
    const { db, job, keys, enqueueNew } = await start();
    const other = await enqueueNew({ prNumber: 8 });

    await keys.remember(job.id, "plain-key-one-0001");
    await keys.remember(job.id, "plain-key-two-0002");
    await keys.remember(other.id, "plain-key-other-0003");

    const rows = await db.selectFrom("job_claimed_keys").selectAll().execute();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("plain-key");
    expect(await keys.keysOf(job.id)).toEqual([
      "plain-key-one-0001",
      "plain-key-two-0002",
    ]);
    expect(await keys.keysOf(other.id)).toEqual(["plain-key-other-0003"]);
  });

  // #276-P3
  it("reads a row of the earlier format, a single plain key, and adds to it", async () => {
    const { db, job, keys, clock } = await start();
    const sealed = encryptSecret(
      APP_SECRET,
      { table: "job_claimed_keys", rowId: job.id, field: "api_key" },
      "plain-key-legacy-0000",
    );
    await createJobClaimedKeysRepository(db, clock.now).put({
      jobId: job.id,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      keyVersion: sealed.keyVersion,
    });
    expect(await keys.keysOf(job.id)).toEqual(["plain-key-legacy-0000"]);

    await keys.remember(job.id, "plain-key-new-0001");

    expect(await keys.keysOf(job.id)).toEqual([
      "plain-key-legacy-0000",
      "plain-key-new-0001",
    ]);
  });

  // #276-P3
  it("reads nothing it cannot decrypt, and a new key then starts the list again", async () => {
    const { db, job, keys } = await start();
    await keys.remember(job.id, "plain-key-one-0001");
    await db.updateTable("job_claimed_keys").set({ nonce: "AAAA" }).execute();

    expect(await keys.keysOf(job.id)).toEqual([]);
    await keys.remember(job.id, "plain-key-two-0002");

    expect(await keys.keysOf(job.id)).toEqual(["plain-key-two-0002"]);
  });
});

describe("the tier models remembered for a job (#280)", () => {
  // #280-T08
  it("keeps the model next to the keys, each list apart, encrypted", async () => {
    const { db, job, keys } = await start();

    await keys.remember(job.id, "plain-key-one-0001");
    await keys.rememberModel(job.id, "tier/the-model");
    await keys.remember(job.id, "plain-key-two-0002");

    expect(await keys.keysOf(job.id)).toEqual([
      "plain-key-one-0001",
      "plain-key-two-0002",
    ]);
    expect(await keys.modelsOf(job.id)).toEqual(["tier/the-model"]);
    expect(
      JSON.stringify(
        await db.selectFrom("job_claimed_keys").selectAll().execute(),
      ),
    ).not.toContain("tier/the-model");
  });

  // #280-T08
  it("does not spend a place twice on one model, forgets the oldest past the bound, and never takes a key's place", async () => {
    const { job, keys } = await start();
    for (const key of ["key-a-0001", "key-b-0002", "key-c-0003"])
      await keys.remember(job.id, key);

    for (const model of ["m/one", "m/one", "m/two", "m/three", "m/four"])
      await keys.rememberModel(job.id, model);

    expect(await keys.keysOf(job.id)).toEqual([
      "key-a-0001",
      "key-b-0002",
      "key-c-0003",
    ]);
    expect(await keys.modelsOf(job.id)).toEqual(["m/two", "m/three", "m/four"]);
  });

  // #280-T08
  it("answers no model for a job that has none, or a row of the earlier format", async () => {
    const { db, job, keys, clock } = await start();
    expect(await keys.modelsOf(job.id)).toEqual([]);
    const sealed = encryptSecret(
      APP_SECRET,
      { table: "job_claimed_keys", rowId: job.id, field: "api_key" },
      "plain-key-legacy-0000",
    );
    await createJobClaimedKeysRepository(db, clock.now).put({
      jobId: job.id,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      keyVersion: sealed.keyVersion,
    });

    expect(await keys.modelsOf(job.id)).toEqual([]);
    await keys.rememberModel(job.id, "tier/the-model");
    expect(await keys.keysOf(job.id)).toEqual(["plain-key-legacy-0000"]);
    expect(await keys.modelsOf(job.id)).toEqual(["tier/the-model"]);
  });
});

describe("the native marker remembered for a job (#578)", () => {
  // #578-T29
  it("says a job was handed a native entry only after the claim noted it", async () => {
    const { job, keys } = await start();
    expect(await keys.wasNative(job.id)).toBe(false);

    await keys.remember(job.id, "plain-key-one-0001");
    expect(await keys.wasNative(job.id)).toBe(false);

    await keys.rememberNative(job.id, true);
    expect(await keys.wasNative(job.id)).toBe(true);
  });

  // #578-T34
  it("is cleared when a later claim says the job is not native", async () => {
    const { job, keys } = await start();
    await keys.remember(job.id, "plain-key-one-0001");
    await keys.rememberNative(job.id, true);
    expect(await keys.wasNative(job.id)).toBe(true);

    await keys.remember(job.id, "plain-key-one-0001");
    await keys.rememberNative(job.id, false);

    expect(await keys.wasNative(job.id)).toBe(false);
    expect(await keys.keysOf(job.id)).toEqual(["plain-key-one-0001"]);
  });

  // #578-T29
  it("keeps the keys and the models apart from it, in whatever order they are noted, and stores it encrypted", async () => {
    const { db, job, keys } = await start();

    await keys.rememberNative(job.id, true);
    await keys.remember(job.id, "plain-key-one-0001");
    await keys.rememberModel(job.id, "tier/the-model");
    await keys.remember(job.id, "plain-key-two-0002");

    expect(await keys.keysOf(job.id)).toEqual([
      "plain-key-one-0001",
      "plain-key-two-0002",
    ]);
    expect(await keys.modelsOf(job.id)).toEqual(["tier/the-model"]);
    expect(await keys.wasNative(job.id)).toBe(true);
    expect(
      JSON.stringify(
        await db.selectFrom("job_claimed_keys").selectAll().execute(),
      ),
    ).not.toContain("native");
  });

  // #578-T29
  it("is not set for a job of another claim, or a row of the earlier format", async () => {
    const { db, job, keys, clock, enqueueNew } = await start();
    const other = await enqueueNew({ headSha: "b".repeat(40) });
    await keys.rememberNative(job.id, true);
    const sealed = encryptSecret(
      APP_SECRET,
      { table: "job_claimed_keys", rowId: other.id, field: "api_key" },
      "plain-key-legacy-0000",
    );
    await createJobClaimedKeysRepository(db, clock.now).put({
      jobId: other.id,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      keyVersion: sealed.keyVersion,
    });

    expect(await keys.wasNative(other.id)).toBe(false);
  });
});
