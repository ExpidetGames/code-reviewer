// SPDX-License-Identifier: Apache-2.0

// Pins down the check behind "GitHub only": the acting admin's GitHub identity has to be one that signs in
// today, that is one the access policy lets through, not just a row in `accounts`. Otherwise switching
// email with password off would lock everybody out, the admin included.
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { AccessPolicy } from "../auth/access-policy.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { githubIdentityPasses } from "./github-identity.ts";

async function startInstance(
  options: { githubLogin?: string | null; linked?: boolean } = {},
) {
  const { db } = await createTestDatabase();
  await sql`insert into users (id, name, email, email_verified, github_login, is_instance_admin, created_at, updated_at)
    values ('admin-1', 'Admin', 'admin@example.test', 1, ${options.githubLogin === undefined ? "octocat" : options.githubLogin}, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
    db,
  );
  if (options.linked !== false)
    await sql`insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
      values ('acc-1', '583231', 'github', 'admin-1', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`.execute(
      db,
    );
  return db;
}

const allow: AccessPolicy = () => Promise.resolve({ allowed: true });
const deny: AccessPolicy = () =>
  Promise.resolve({ allowed: false, reason: "not_allowed" });

describe("a GitHub identity that would sign in", () => {
  // #98-AD-16
  it("passes when the access policy lets it through, and is asked with the login and the GitHub id", async () => {
    const db = await startInstance();
    const policy = vi.fn(allow);

    const passes = await githubIdentityPasses(db, policy, "admin-1");

    expect(passes).toBe(true);
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "admin-1",
        githubLogin: "octocat",
        githubId: "583231",
      }),
    );
  });

  // #98-AD-16
  it("does not pass when the access policy turns it away", async () => {
    const db = await startInstance();

    expect(await githubIdentityPasses(db, deny, "admin-1")).toBe(false);
  });

  // #98-AD-16
  it("does not pass without a linked GitHub account, or when its login is not known", async () => {
    const unlinked = await startInstance({ linked: false });
    const noLogin = await startInstance({ githubLogin: null });
    const policy = vi.fn(allow);

    expect(await githubIdentityPasses(unlinked, policy, "admin-1")).toBe(false);
    expect(await githubIdentityPasses(noLogin, policy, "admin-1")).toBe(false);
    expect(policy).not.toHaveBeenCalled();
  });

  it("does not pass when the check cannot be made", async () => {
    const db = await startInstance();

    expect(
      await githubIdentityPasses(
        db,
        () => Promise.reject(new Error("GitHub unreachable")),
        "admin-1",
      ),
    ).toBe(false);
  });

  it("does not pass for a user that does not exist", async () => {
    const db = await startInstance();

    expect(await githubIdentityPasses(db, allow, "nobody")).toBe(false);
  });
});
