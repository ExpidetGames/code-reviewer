// Pins down the config validation every provider uses: one error per offending field, and a hard
// refusal of keys that look like secrets.
import { describe, expect, it } from "vitest";
import {
  findSecretLikeKeys,
  validateConfigAgainstSchema,
  type ConfigSchema,
} from "./config-schema.ts";

const schema: ConfigSchema = {
  accountLogin: { type: "string" },
  accountId: { type: "number" },
  note: { type: "string", required: false },
};

describe("validating an integration config", () => {
  // CR-20-T04
  it("accepts a config that has every required field with the right type", () => {
    const result = validateConfigAgainstSchema(schema, {
      accountLogin: "acme",
      accountId: 5,
    });

    expect(result).toEqual({
      ok: true,
      config: { accountLogin: "acme", accountId: 5 },
    });
  });

  // CR-20-T04
  it("reports one error for each missing required field", () => {
    const result = validateConfigAgainstSchema(schema, {});

    expect(result).toEqual({
      ok: false,
      errors: [
        { field: "accountLogin", code: "required" },
        { field: "accountId", code: "required" },
      ],
    });
  });

  // CR-20-T04
  it("reports one error for each field with the wrong type", () => {
    const result = validateConfigAgainstSchema(schema, {
      accountLogin: 12,
      accountId: "5",
      note: true,
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        { field: "accountLogin", code: "invalid_type" },
        { field: "accountId", code: "invalid_type" },
        { field: "note", code: "invalid_type" },
      ],
    });
  });

  // CR-20-T04
  it("reports a field the schema does not know instead of storing it silently", () => {
    const result = validateConfigAgainstSchema(schema, {
      accountLogin: "acme",
      accountId: 5,
      privateKey: "x",
    });

    expect(result).toEqual({
      ok: false,
      errors: [{ field: "privateKey", code: "unknown_field" }],
    });
  });

  // CR-20-T04
  it("rejects a config that is not an object", () => {
    for (const input of [null, undefined, "text", 3, ["a"]]) {
      expect(validateConfigAgainstSchema(schema, input)).toEqual({
        ok: false,
        errors: [{ field: "$", code: "invalid_type" }],
      });
    }
  });
});

describe("finding keys that look like secrets", () => {
  it("finds secret-like keys at any depth and names their path", () => {
    expect(
      findSecretLikeKeys({
        accountLogin: "acme",
        auth: { apiToken: "x", list: [{ webhook_secret: "y" }] },
        PrivateKey: "z",
      }),
    ).toEqual(["auth.apiToken", "auth.list.0.webhook_secret", "PrivateKey"]);
  });

  it("finds nothing in a plain config", () => {
    expect(findSecretLikeKeys({ accountLogin: "acme", accountId: 5 })).toEqual(
      [],
    );
  });
});
