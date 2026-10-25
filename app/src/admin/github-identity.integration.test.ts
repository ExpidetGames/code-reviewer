// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the check behind "GitHub only": the acting admin has a GitHub identity linked, a row in `accounts`
// of the GitHub provider with a numeric GitHub id. Otherwise switching email with password off would lock
// everybody out, the admin included.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-support/test-database.ts";
import { githubIdentityLinked } from "./github-identity.ts";

async function startInstance(options: { linked?: boolean } = {}) {
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, github_login, is_instance_admin, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 1, 'octocat', 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
    db,
  );
  if (options.linked !== false)
    await sql`insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
      values ('acc-1', '583231', 'github', 'admin-1', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
  return db;
}

describe("a linked GitHub identity", () => {
  // #98-AD-16, #102-GH-22
  it("is found for a user with a GitHub account row", async () => {
    const db = await startInstance();

    expect(await githubIdentityLinked(db, "admin-1")).toBe(true);
  });

  // #98-AD-16, #102-GH-22
  it("is not found for a user without a GitHub account row", async () => {
    const db = await startInstance({ linked: false });

    expect(await githubIdentityLinked(db, "admin-1")).toBe(false);
  });

  it("is not found for a user that does not exist, or for an account of another provider", async () => {
    const db = await startInstance({ linked: false });
    await sql`insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
      values ('acc-2', 'x', 'credential', 'admin-1', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );

    expect(await githubIdentityLinked(db, "nobody")).toBe(false);
    expect(await githubIdentityLinked(db, "admin-1")).toBe(false);
  });
});
