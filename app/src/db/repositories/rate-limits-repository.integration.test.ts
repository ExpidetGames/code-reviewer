// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the shared rate limit counters against a real Postgres database: attempts are counted per key
// inside a window, a new window starts the count again, keys do not share a counter, and attempts
// that arrive together are all counted.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createRateLimitsRepository } from "./rate-limits-repository.ts";

const MINUTE = 60_000;

describe("the rate limits repository", () => {
  it("counts the attempts of one key inside a window", async () => {
    const { db } = await createTestDatabase();
    const now = new Date("2026-10-11T08:00:00.000Z");
    const repository = createRateLimitsRepository(db, () => now);

    const counts = [];
    for (let attempt = 0; attempt < 3; attempt += 1)
      counts.push((await repository.hit("sign-in:a", MINUTE)).count);

    expect(counts).toEqual([1, 2, 3]);
  });

  it("starts again at 1 when the window is over and keeps the new window's start", async () => {
    const { db } = await createTestDatabase();
    let now = new Date("2026-10-11T08:00:00.000Z");
    const repository = createRateLimitsRepository(db, () => now);
    await repository.hit("sign-in:a", MINUTE);
    await repository.hit("sign-in:a", MINUTE);

    now = new Date("2026-10-11T08:01:00.000Z");
    const afterWindow = await repository.hit("sign-in:a", MINUTE);

    expect(afterWindow.count).toBe(1);
    expect(afterWindow.windowStartedAt.toISOString()).toBe(
      "2026-10-11T08:01:00.000Z",
    );
  });

  it("keeps the start of the window while it is running", async () => {
    const { db } = await createTestDatabase();
    let now = new Date("2026-10-11T08:00:00.000Z");
    const repository = createRateLimitsRepository(db, () => now);
    await repository.hit("k", MINUTE);

    now = new Date("2026-10-11T08:00:59.000Z");
    const inside = await repository.hit("k", MINUTE);

    expect(inside.count).toBe(2);
    expect(inside.windowStartedAt.toISOString()).toBe(
      "2026-10-11T08:00:00.000Z",
    );
  });

  it("keeps the counters of different keys apart", async () => {
    const { db } = await createTestDatabase();
    const repository = createRateLimitsRepository(db);
    await repository.hit("a", MINUTE);
    await repository.hit("a", MINUTE);

    expect((await repository.hit("b", MINUTE)).count).toBe(1);
  });

  it("counts attempts that arrive at the same moment", async () => {
    const { db } = await createTestDatabase();
    const repository = createRateLimitsRepository(db);

    const hits = await Promise.all(
      Array.from({ length: 10 }, () => repository.hit("burst", MINUTE)),
    );

    expect(hits.map((hit) => hit.count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("forgets a counter on reset and deletes the counters whose window is over", async () => {
    const { db } = await createTestDatabase();
    let now = new Date("2026-10-11T08:00:00.000Z");
    const repository = createRateLimitsRepository(db, () => now);
    await repository.hit("old", MINUTE);
    await repository.hit("reset-me", MINUTE);
    now = new Date("2026-10-11T08:05:00.000Z");
    await repository.hit("fresh", MINUTE);
    await repository.reset("reset-me");

    expect(await repository.deleteExpired(MINUTE)).toBe(1);

    expect((await repository.hit("old", MINUTE)).count).toBe(1);
    expect((await repository.hit("fresh", MINUTE)).count).toBe(2);
    expect((await repository.hit("reset-me", MINUTE)).count).toBe(1);
  });

  it("takes one attempt back, never below zero", async () => {
    const { db } = await createTestDatabase();
    const repository = createRateLimitsRepository(db);
    await repository.hit("refunded", MINUTE);
    await repository.hit("refunded", MINUTE);

    await repository.refund("refunded");
    await repository.refund("refunded");
    await repository.refund("refunded");
    await repository.refund("never-counted");

    expect((await repository.hit("refunded", MINUTE)).count).toBe(1);
  });
});
