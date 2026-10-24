// SPDX-License-Identifier: LicenseRef-Proprietary

// Which GitHub accounts a workspace's installations tie it to (#507, pure): the grant is per account, so what counts as an
// account id decides who can be granted.
import { describe, expect, it } from "vitest";
import { isGithubAccountId } from "../db/repositories/billing-start-credit-grants-repository.ts";
import { githubAccountsOf } from "./start-credit.ts";

/** The config text of an installation, the way the table stores it. */
const installation = (config: unknown) => JSON.stringify(config);

describe("the GitHub accounts of a workspace", () => {
  it("takes the numeric account id of every installation, once", () => {
    expect(
      githubAccountsOf([
        installation({ accountId: 42 }),
        installation({ accountId: 42 }),
        installation({ accountId: 7 }),
        installation({ accountId: "99" }),
      ]),
    ).toEqual(["42", "7", "99"]);
  });

  // #507-T11
  it("skips a config that cannot be read instead of throwing", () => {
    expect(
      githubAccountsOf([
        "{not json",
        "",
        "null",
        "[1, 2]",
        '"text"',
        "42",
        installation({ accountId: 5 }),
      ]),
    ).toEqual(["5"]);
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
