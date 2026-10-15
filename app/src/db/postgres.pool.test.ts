// SPDX-License-Identifier: Apache-2.0

// The pool settings of the Postgres connection (#319): serverless gets a small pool with a short idle
// timeout that the platform hook is told about; the server keeps exactly the pool it always had. Nothing
// connects: a pool opens its connections on the first query.
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { openPostgresDatabase } from "./postgres.ts";

const url = "postgres://app:pw@127.0.0.1:1/app";

describe("openPostgresDatabase pool settings", () => {
  // #319-T07
  it("hands the pool to the platform hook with the small size and the short idle timeout in serverless mode", async () => {
    const attachPool = vi.fn<(pool: Pool) => void>();

    const db = openPostgresDatabase(
      {
        driver: "postgres",
        url,
        poolMax: 3,
        idleTimeoutMs: 5000,
        attachPlatformPool: true,
      },
      { attachPool },
    );

    expect(attachPool).toHaveBeenCalledTimes(1);
    const pool = attachPool.mock.calls[0]?.[0];
    expect(pool?.options.max).toBe(3);
    expect(pool?.options.idleTimeoutMillis).toBe(5000);
    await db.destroy();
  });

  // #319-T06
  it("does not touch the platform hook or the idle timeout in server mode", async () => {
    const attachPool = vi.fn<(pool: Pool) => void>();

    const db = openPostgresDatabase(
      { driver: "postgres", url, poolMax: 10 },
      { attachPool },
    );

    expect(attachPool).not.toHaveBeenCalled();
    await db.destroy();
  });

  // #319-T05
  it("opens no connection until the first query", async () => {
    const db = openPostgresDatabase(
      { driver: "postgres", url, poolMax: 3, idleTimeoutMs: 5000 },
      { attachPool: () => undefined },
    );

    // Nothing listens on port 1: opening eagerly would have rejected or left an unhandled error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.destroy();
  });
});
