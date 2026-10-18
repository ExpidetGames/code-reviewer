// SPDX-License-Identifier: Apache-2.0

// The money guardrail of the prices the app creates (#440, ADR 0005, 2.11): the app never edits an amount. The client refuses a
// PATCH of a money field at run time (#436-T07, paddle-client.test.ts); this test pins the callers: in the billing module a price
// is edited from one place only, the archive, and only to set its status to `archived`; no other file speaks PATCH.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIRECTORY = import.meta.dirname;
const sources = readdirSync(DIRECTORY)
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .map((name) => ({
    name,
    text: readFileSync(join(DIRECTORY, name), "utf8"),
  }));

describe("the callers of a price edit", () => {
  // #440-T07
  it("are the archive alone, and it sets the status to archived and nothing else", () => {
    const callers = sources.filter((file) => /\.updatePrice\(/.test(file.text));

    expect(callers.map((file) => file.name)).toEqual(["prices-archive.ts"]);
    const calls = callers[0]?.text.match(/\.updatePrice\([^)]*\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\{\s*status:\s*"archived"\s*\}/);
  });

  // #440-T07
  it("never name a method that edits something at Paddle but the client, in a price create request or elsewhere", () => {
    const patchers = sources.filter((file) =>
      /["'`]PATCH["'`]/.test(file.text),
    );

    expect(patchers.map((file) => file.name)).toEqual(["paddle-client.ts"]);
  });

  // #440-T07
  it("send the request of a created price from the pure builder, which has no way to carry an override or a PATCH field", () => {
    const text =
      sources.find((file) => file.name === "price-create-rules.ts")?.text ?? "";

    expect(text).not.toMatch(/unit_price_overrides/);
    expect(
      sources
        .filter((file) => /\.createPrice\(/.test(file.text))
        .map((file) => file.name),
    ).toEqual(["prices-create.ts"]);
  });
});
