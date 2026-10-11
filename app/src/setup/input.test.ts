// SPDX-License-Identifier: Apache-2.0

// Pins down the validation of the wizard's request: the three choices, the entries of the sign-up
// rule, the admin email and the password rule, each problem with its own stable code and field, and
// never a value in the answer.
import { describe, expect, it } from "vitest";
import { parseSetupInput } from "./input.ts";

const GOOD = {
  tenancy: "single",
  signUp: { kind: "everyone" },
  admin: { email: "Admin@Example.com", password: "x7Kq-m2Vd9Lw" },
};

function issues(body: unknown) {
  const parsed = parseSetupInput(body);
  return parsed.ok ? [] : parsed.issues;
}

describe("parsing the setup request", () => {
  it("accepts a complete request and normalizes the admin email", () => {
    expect(parseSetupInput(GOOD)).toEqual({
      ok: true,
      input: {
        tenancy: "single",
        signUp: { kind: "everyone" },
        admin: { email: "admin@example.com", password: "x7Kq-m2Vd9Lw" },
      },
    });
  });

  it("accepts multi tenancy", () => {
    expect(parseSetupInput({ ...GOOD, tenancy: "multi" })).toMatchObject({
      ok: true,
      input: { tenancy: "multi" },
    });
  });

  it.each([undefined, "triple", 1, null])(
    "refuses the tenancy %j",
    (tenancy) => {
      expect(issues({ ...GOOD, tenancy })).toEqual([
        { field: "tenancy", code: "tenancy_invalid" },
      ]);
    },
  );

  // #97-SU-19
  it("accepts a list of emails, lower-cases them and drops empty and repeated entries", () => {
    const parsed = parseSetupInput({
      ...GOOD,
      signUp: {
        kind: "emails",
        entries: [
          " Anna@Example.com ",
          "",
          "anna@example.com",
          "bob@example.org",
        ],
      },
    });

    expect(parsed).toMatchObject({
      ok: true,
      input: {
        signUp: {
          kind: "emails",
          entries: ["anna@example.com", "bob@example.org"],
        },
      },
    });
  });

  // #97-SU-19
  it("accepts allowed domains, with or without a leading @", () => {
    const parsed = parseSetupInput({
      ...GOOD,
      signUp: {
        kind: "domains",
        entries: ["Example.com", "@team.example.org"],
      },
    });

    expect(parsed).toMatchObject({
      ok: true,
      input: {
        signUp: {
          kind: "domains",
          entries: ["example.com", "team.example.org"],
        },
      },
    });
  });

  it("refuses a rule that needs entries when there are none", () => {
    for (const kind of ["emails", "domains"])
      for (const entries of [[], [""], undefined, "a@b.co"])
        expect(issues({ ...GOOD, signUp: { kind, entries } })).toEqual([
          { field: "signUp.entries", code: "entries_required" },
        ]);
  });

  it("refuses an entry that is not an email or a domain", () => {
    expect(
      issues({
        ...GOOD,
        signUp: { kind: "emails", entries: ["not an email"] },
      }),
    ).toEqual([{ field: "signUp.entries", code: "entry_invalid" }]);
    expect(
      issues({ ...GOOD, signUp: { kind: "domains", entries: ["localhost"] } }),
    ).toEqual([{ field: "signUp.entries", code: "entry_invalid" }]);
    expect(
      issues({ ...GOOD, signUp: { kind: "domains", entries: [42] } }),
    ).toEqual([{ field: "signUp.entries", code: "entry_invalid" }]);
  });

  it("refuses too many entries and an unknown rule", () => {
    const entries = Array.from(
      { length: 501 },
      (_, i) => `u${String(i)}@example.com`,
    );

    expect(issues({ ...GOOD, signUp: { kind: "emails", entries } })).toEqual([
      { field: "signUp.entries", code: "too_many_entries" },
    ]);
    expect(issues({ ...GOOD, signUp: { kind: "github-org" } })).toEqual([
      { field: "signUp.kind", code: "sign_up_rule_invalid" },
    ]);
    expect(issues({ ...GOOD, signUp: "everyone" })).toEqual([
      { field: "signUp", code: "sign_up_rule_invalid" },
    ]);
  });

  it.each([
    "",
    "admin",
    "admin@",
    "@example.com",
    "a b@example.com",
    "admin@example",
    "admin@.com",
  ])("refuses the admin email %j", (email) => {
    expect(issues({ ...GOOD, admin: { ...GOOD.admin, email } })).toEqual([
      { field: "admin.email", code: "email_invalid" },
    ]);
  });

  // #97-SU-10
  it("reports the password rule with its stable codes", () => {
    const code = (password: unknown) =>
      issues({ ...GOOD, admin: { ...GOOD.admin, password } });

    expect(code("short")).toEqual([
      { field: "admin.password", code: "password_too_short" },
    ]);
    expect(code("a".repeat(129))).toEqual([
      { field: "admin.password", code: "password_too_long" },
    ]);
    expect(code("password1234")).toEqual([
      { field: "admin.password", code: "password_too_common" },
    ]);
    expect(code(undefined)).toEqual([
      { field: "admin.password", code: "password_too_short" },
    ]);
  });

  it("reports every problem at once and never repeats a value", () => {
    const result = issues({
      tenancy: "x",
      signUp: { kind: "emails", entries: ["bad value here"] },
      admin: { email: "nope", password: "secret-password-in-the-body" },
    });

    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(result)).not.toContain("secret-password-in-the-body");
    expect(JSON.stringify(result)).not.toContain("bad value here");
  });

  it.each([null, undefined, "text", 42, []])("refuses the body %j", (body) => {
    expect(issues(body)).toEqual([{ field: "", code: "body_invalid" }]);
  });
});
