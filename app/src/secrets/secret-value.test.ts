// SPDX-License-Identifier: Apache-2.0

// Pins down the wrapper around a revealed secret: the value is reachable on purpose (`reveal`) and
// by no accident, so a secret that ends up in a log call, a string, JSON or an error is shown as a
// placeholder.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SecretValue } from "./secret-value.ts";

describe("a secret value", () => {
  it("gives the value back when asked for it", () => {
    expect(new SecretValue("the-value").reveal()).toBe("the-value");
  });

  it("is a placeholder when turned into a string, JSON or an inspection", () => {
    const secret = new SecretValue("the-value");

    expect(String(secret)).toBe("[secret]");
    expect(`${secret}`).toBe("[secret]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}');
    expect(inspect(secret)).toBe("[secret]");
    expect(JSON.stringify(Object.entries(secret))).not.toContain("the-value");
  });

  it("keeps the value out of its own properties", () => {
    const secret = new SecretValue("the-value");

    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect(JSON.stringify(Reflect.ownKeys(secret))).not.toContain("the-value");
  });
});
