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
  it("reports names from the prototype chain as unknown fields instead of dropping them", () => {
    for (const field of ["constructor", "toString", "hasOwnProperty"]) {
      const result = validateConfigAgainstSchema(schema, {
        accountLogin: "acme",
        accountId: 5,
        [field]: "x",
      });

      expect(result).toEqual({
        ok: false,
        errors: [{ field, code: "unknown_field" }],
      });
    }
  });

  // CR-20-T04
  it("reports a __proto__ key from parsed JSON as an unknown field", () => {
    const parsed = JSON.parse(
      '{"accountLogin":"acme","accountId":5,"__proto__":{"x":1}}',
    );

    expect(validateConfigAgainstSchema(schema, parsed)).toEqual({
      ok: false,
      errors: [{ field: "__proto__", code: "unknown_field" }],
    });
  });

  // CR-20-T04
  it("rejects numbers that do not survive JSON", () => {
    for (const accountId of [NaN, Infinity, -Infinity]) {
      expect(
        validateConfigAgainstSchema(schema, {
          accountLogin: "acme",
          accountId,
        }),
      ).toEqual({
        ok: false,
        errors: [{ field: "accountId", code: "invalid_type" }],
      });
    }
  });

  // CR-20-T04
  it("treats an explicit null as not given: required fails, optional is left out", () => {
    expect(
      validateConfigAgainstSchema(schema, {
        accountLogin: null,
        accountId: 5,
        note: null,
      }),
    ).toEqual({
      ok: false,
      errors: [{ field: "accountLogin", code: "required" }],
    });
    expect(
      validateConfigAgainstSchema(schema, {
        accountLogin: "acme",
        accountId: 5,
        note: null,
      }),
    ).toEqual({ ok: true, config: { accountLogin: "acme", accountId: 5 } });
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

  it("finds the usual spellings of keys, tokens, passwords and certificates", () => {
    const keys = [
      "apiKey",
      "api_key",
      "accessKey",
      "client_secret",
      "clientSecret",
      "authorization",
      "jwt",
      "pem",
      "keyPem",
      "private_pem",
      "password",
      "bearerToken",
    ];

    expect(
      findSecretLikeKeys(Object.fromEntries(keys.map((k) => [k, "x"]))),
    ).toEqual(keys);
  });

  it("does not flag keys that only mention a secret word, such as urls and counts", () => {
    expect(
      findSecretLikeKeys({
        access_tokens_url:
          "https://api.example.test/app/installations/1/access_tokens",
        tokenCount: 3,
        token_id: 9,
        development: "x",
        company: "x",
      }),
    ).toEqual([]);
  });

  it("finds nothing in a plain config", () => {
    expect(findSecretLikeKeys({ accountLogin: "acme", accountId: 5 })).toEqual(
      [],
    );
  });
});
