// Pins down how the master key is read: APP_SECRET first, the old BETTER_AUTH_SECRET as a fallback
// that is reported as deprecated, and a problem that names the variable otherwise.
import { describe, expect, it } from "vitest";
import {
  conflictingAppSecretWarning,
  legacyAppSecretWarning,
  resolveAppSecret,
} from "./app-secret.ts";

const SECRET = "app-secret-0123456789-0123456789-abcdef";
const OLD = "legacy-secret-0123456789-0123456789-abc";

describe("resolveAppSecret", () => {
  it("uses APP_SECRET", () => {
    expect(resolveAppSecret({ APP_SECRET: SECRET })).toEqual({
      ok: true,
      secret: SECRET,
      source: "APP_SECRET",
    });
  });

  // #97-SU-17
  it("falls back to BETTER_AUTH_SECRET when APP_SECRET is not set", () => {
    expect(resolveAppSecret({ BETTER_AUTH_SECRET: OLD })).toEqual({
      ok: true,
      secret: OLD,
      source: "BETTER_AUTH_SECRET",
    });
  });

  it("prefers APP_SECRET when both are set", () => {
    expect(
      resolveAppSecret({ APP_SECRET: SECRET, BETTER_AUTH_SECRET: OLD }),
    ).toMatchObject({ ok: true, secret: SECRET, source: "APP_SECRET" });
  });

  // #97-SU-17
  it("names APP_SECRET when neither variable is set or the value is blank", () => {
    for (const env of [{}, { APP_SECRET: "   " }, { BETTER_AUTH_SECRET: "" }]) {
      const result = resolveAppSecret(env);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.problem).toContain("APP_SECRET");
    }
  });

  it("names the variable in use when the secret is shorter than 32 characters", () => {
    const current = resolveAppSecret({ APP_SECRET: "short" });
    const legacy = resolveAppSecret({ BETTER_AUTH_SECRET: "short" });

    expect(!current.ok && current.problem).toContain("APP_SECRET");
    expect(!legacy.ok && legacy.problem).toContain("BETTER_AUTH_SECRET");
  });

  it("never puts the value into a problem", () => {
    const result = resolveAppSecret({ APP_SECRET: "too-short-secret" });

    expect(!result.ok && result.problem).not.toContain("too-short-secret");
  });
});

describe("legacyAppSecretWarning", () => {
  // #97-SU-17
  it("warns only when the old variable is the one in use", () => {
    expect(legacyAppSecretWarning({ BETTER_AUTH_SECRET: OLD })).toContain(
      "deprecated",
    );
    expect(legacyAppSecretWarning({ APP_SECRET: SECRET })).toBeNull();
    expect(
      legacyAppSecretWarning({ APP_SECRET: SECRET, BETTER_AUTH_SECRET: OLD }),
    ).toBeNull();
    expect(legacyAppSecretWarning({})).toBeNull();
  });

  it("does not contain the secret", () => {
    expect(legacyAppSecretWarning({ BETTER_AUTH_SECRET: OLD })).not.toContain(
      OLD,
    );
  });
});

describe("conflictingAppSecretWarning", () => {
  // #97-SU-17
  it("warns, naming both variables and no value, when both are set and differ", () => {
    const line = conflictingAppSecretWarning({
      APP_SECRET: SECRET,
      BETTER_AUTH_SECRET: OLD,
    });

    expect(line).toContain("APP_SECRET");
    expect(line).toContain("BETTER_AUTH_SECRET");
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain(OLD);
    expect(line).not.toContain("\n");
  });

  it("says nothing when only one is set, when both are the same, or when one is blank", () => {
    expect(conflictingAppSecretWarning({ APP_SECRET: SECRET })).toBeNull();
    expect(conflictingAppSecretWarning({ BETTER_AUTH_SECRET: OLD })).toBeNull();
    expect(
      conflictingAppSecretWarning({
        APP_SECRET: SECRET,
        BETTER_AUTH_SECRET: ` ${SECRET} `,
      }),
    ).toBeNull();
    expect(
      conflictingAppSecretWarning({
        APP_SECRET: SECRET,
        BETTER_AUTH_SECRET: "  ",
      }),
    ).toBeNull();
  });
});
