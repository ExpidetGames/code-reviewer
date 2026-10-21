// SPDX-License-Identifier: Apache-2.0

// Which GitHub accounts a workspace's installations tie it to (#507, pure): the grant is per account, so what counts as an
// account id decides who can be granted.
import { describe, expect, it } from "vitest";
import { isGithubAccountId } from "../db/repositories/billing-start-credit-grants-repository.ts";
import type { Integration } from "../integrations/types.ts";
import { githubAccountsOf } from "./start-credit.ts";

function installation(
  config: Integration["config"],
  status: Integration["status"] = "active",
): Integration {
  return {
    id: "i",
    workspaceId: "w",
    type: "github_app",
    displayName: "acme",
    externalId: "1",
    config,
    credentials: null,
    webhookSecret: null,
    status,
    createdAt: "2026-10-21T08:00:00.000Z",
    updatedAt: "2026-10-21T08:00:00.000Z",
  };
}

describe("the GitHub accounts of a workspace", () => {
  it("takes the numeric account id of every installation that is not disconnected, once", () => {
    expect(
      githubAccountsOf([
        installation({ accountId: 42 }),
        installation({ accountId: 42 }),
        installation({ accountId: 7 }, "disabled"),
        installation({ accountId: 8 }, "disconnected"),
        installation({ accountId: "99" }),
      ]),
    ).toEqual(["42", "7", "99"]);
  });

  it("ignores an installation that names no account id or a value that is no id", () => {
    expect(
      githubAccountsOf([
        installation({}),
        installation({ accountId: null }),
        installation({ accountId: 0 }),
        installation({ accountId: -5 }),
        installation({ accountId: 1.5 }),
        installation({ accountId: "octocat" }),
        installation({ accountId: " 12" }),
        installation({ accountId: "012" }),
        installation({ accountId: 2 ** 60 }),
      ]),
    ).toEqual([]);
  });

  it("accepts a plain positive number as text and nothing else", () => {
    for (const good of ["1", "123456789", "9007199254740991"])
      expect(isGithubAccountId(good)).toBe(true);
    for (const bad of ["", "0", "01", "-1", "1.0", "1e3", "a1", " 1", 1, null])
      expect(isGithubAccountId(bad)).toBe(false);
  });
});
