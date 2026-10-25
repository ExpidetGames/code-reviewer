// SPDX-License-Identifier: LicenseRef-Proprietary

// The landing identity on a user is written once, the first time, and never replaced.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { insertUser } from "../test-support/users.ts";
import { recordLandingIdentity } from "./store.ts";

const FIRST = new Date("2026-10-25T10:00:00.000Z");
const LATER = new Date("2026-10-26T10:00:00.000Z");

async function setup() {
  const { db } = await createTestDatabase();
  await insertUser(db, { id: "u-1" });
  const read = () =>
    db
      .selectFrom("users")
      .select([
        "posthog_distinct_id",
        "posthog_session_id",
        "posthog_captured_at",
      ])
      .where("id", "=", "u-1")
      .executeTakeFirstOrThrow();
  return { db, read };
}

describe("storing the landing identity on a user", () => {
  // #692-T05
  it("writes both identifiers and the time on a user that has none", async () => {
    const { db, read } = await setup();

    const written = await recordLandingIdentity(
      db,
      "u-1",
      { distinctId: "did-1", sessionId: "sid-1" },
      FIRST,
    );

    expect(written).toBe(true);
    expect(await read()).toEqual({
      posthog_distinct_id: "did-1",
      posthog_session_id: "sid-1",
      posthog_captured_at: "2026-10-25T10:00:00.000Z",
    });
  });

  // #692-T05
  it("keeps what is there: a later identity does not replace the first one", async () => {
    const { db, read } = await setup();
    await recordLandingIdentity(
      db,
      "u-1",
      { distinctId: "did-1", sessionId: "sid-1" },
      FIRST,
    );

    const written = await recordLandingIdentity(
      db,
      "u-1",
      { distinctId: "did-2", sessionId: "sid-2" },
      LATER,
    );

    expect(written).toBe(false);
    expect(await read()).toEqual({
      posthog_distinct_id: "did-1",
      posthog_session_id: "sid-1",
      posthog_captured_at: "2026-10-25T10:00:00.000Z",
    });
  });

  // #692-T05
  it("writes only the identifier that came, and counts that as the first touch", async () => {
    const { db, read } = await setup();

    await recordLandingIdentity(
      db,
      "u-1",
      { distinctId: "did-1", sessionId: null },
      FIRST,
    );
    const second = await recordLandingIdentity(
      db,
      "u-1",
      { distinctId: null, sessionId: "sid-2" },
      LATER,
    );

    expect(second).toBe(false);
    expect(await read()).toEqual({
      posthog_distinct_id: "did-1",
      posthog_session_id: null,
      posthog_captured_at: "2026-10-25T10:00:00.000Z",
    });
  });

  it("writes nothing for a user that does not exist", async () => {
    const { db } = await setup();

    expect(
      await recordLandingIdentity(
        db,
        "nobody",
        { distinctId: "did-1", sessionId: null },
        FIRST,
      ),
    ).toBe(false);
  });
});
