// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { withoutColumnsAddedLater } from "./columns-added-later.ts";

describe("comparing rows without the columns a later migration added", () => {
  // #658-T03
  it("drops the column that holds its default and leaves the other columns and tables alone", () => {
    const rows = [{ id: "w-1", slug: "acme", deleted_at: null }];

    expect(withoutColumnsAddedLater("workspaces", rows)).toEqual([
      { id: "w-1", slug: "acme" },
    ]);
    expect(withoutColumnsAddedLater("users", rows)).toEqual(rows);
    expect(withoutColumnsAddedLater("workspaces", [{ id: "w-1" }])).toEqual([
      { id: "w-1" },
    ]);
  });

  // #658-T03
  it("refuses a row that a migration backfilled: that is a change to an existing row", () => {
    expect(() =>
      withoutColumnsAddedLater("workspaces", [
        { id: "w-1", deleted_at: "2026-10-23T12:00:00.000Z" },
      ]),
    ).toThrow(/must be null/);
  });
});
