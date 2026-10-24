// SPDX-License-Identifier: LicenseRef-Proprietary

// Reading the environment of an installation from before accounts: which variables are legacy, which of them can
// be imported, and that an unusable one is named and never quoted.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readLegacyEnvironment, setLegacyVariables } from "./environment.ts";

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const directory = mkdtempSync(join(tmpdir(), "legacy-env-"));
const keyPath = join(directory, "app.pem");
writeFileSync(keyPath, KEY);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const APP = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "code-reviewer",
  GITHUB_APP_WEBHOOK_SECRET: "webhook-secret-value",
  GITHUB_APP_PRIVATE_KEY: KEY,
};

describe("reading the GitHub App of the environment", () => {
  // #106-IM-01
  it("takes a complete App", () => {
    const { github } = readLegacyEnvironment(APP);

    expect(github).toMatchObject({
      kind: "usable",
      appId: "123456",
      slug: "code-reviewer",
    });
  });

  // #106-IM-01
  it("takes the key from a file and from a one line value with escaped line breaks", () => {
    const fromFile = readLegacyEnvironment({
      ...APP,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    });
    const escaped = readLegacyEnvironment({
      ...APP,
      GITHUB_APP_PRIVATE_KEY: KEY.replaceAll("\n", "\\n"),
    });

    expect(fromFile.github.kind).toBe("usable");
    expect(escaped.github.kind).toBe("usable");
  });

  // #106-IM-13
  it("finds no App when no variable is set", () => {
    expect(readLegacyEnvironment({}).github).toEqual({ kind: "absent" });
  });

  // #106-IM-14
  it.each([
    [
      "a broken key",
      { GITHUB_APP_PRIVATE_KEY: "not a key" },
      "GITHUB_APP_PRIVATE_KEY",
    ],
    [
      "a missing secret",
      { GITHUB_APP_WEBHOOK_SECRET: undefined },
      "GITHUB_APP_WEBHOOK_SECRET",
    ],
    ["an id that is not a number", { GITHUB_APP_ID: "abc" }, "GITHUB_APP_ID"],
    [
      "a file that is not there",
      {
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_APP_PRIVATE_KEY_PATH: "/no/such/file.pem",
      },
      "GITHUB_APP_PRIVATE_KEY_PATH",
    ],
  ])(
    "does not use %s and names only the variable",
    (_case, change, variable) => {
      const { github } = readLegacyEnvironment({ ...APP, ...change });

      expect(github.kind).toBe("unusable");
      if (github.kind !== "unusable") return;
      expect(github.variables).toContain(variable);
      expect(JSON.stringify(github)).not.toContain("not a key");
      expect(JSON.stringify(github)).not.toContain("/no/such/file");
    },
  );
});

describe("reading the LLM key of the environment", () => {
  // #106-IM-01
  it("takes a key with its provider, and the model only when it is not the built-in one", () => {
    const withModel = readLegacyEnvironment({
      LLM_PROVIDER: "OpenRouter",
      LLM_API_KEY: ` sk-or-key-0123456789\n`,
      LLM_MODEL: "vendor/model",
    }).llm;
    const builtIn = readLegacyEnvironment({
      LLM_PROVIDER: "openrouter",
      LLM_API_KEY: "sk-or-key-0123456789",
      LLM_MODEL: "anthropic/claude-haiku-5.5",
    }).llm;

    expect(withModel).toEqual({
      kind: "usable",
      provider: "openrouter",
      apiKey: "sk-or-key-0123456789",
      model: "vendor/model",
    });
    expect(builtIn).toMatchObject({ kind: "usable", model: null });
  });

  it("finds no key without LLM_API_KEY, and names the variable that cannot be used", () => {
    expect(readLegacyEnvironment({ LLM_PROVIDER: "openrouter" }).llm).toEqual({
      kind: "absent",
    });
    expect(
      readLegacyEnvironment({
        LLM_PROVIDER: "other",
        LLM_API_KEY: "sk-or-key-0123456789",
      }).llm,
    ).toEqual({ kind: "unusable", variables: ["LLM_PROVIDER"] });
    expect(
      readLegacyEnvironment({
        LLM_PROVIDER: "openrouter",
        LLM_API_KEY: "has a space",
      }).llm,
    ).toEqual({ kind: "unusable", variables: ["LLM_API_KEY"] });
  });
});

describe("the legacy variables that are set", () => {
  // #106-IM-01
  it("lists names only, in a fixed order, and not the compose default of the provider", () => {
    expect(
      setLegacyVariables({
        ...APP,
        LLM_PROVIDER: "openrouter",
        LLM_API_KEY: "k",
        ALLOWED_GITHUB_ORG: "acme",
        GITHUB_OAUTH_CLIENT_ID: "x",
        BETTER_AUTH_SECRET: "s",
        RUNNER_TOKEN: "t",
      }),
    ).toEqual([
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_OAUTH_CLIENT_ID",
      "ALLOWED_GITHUB_ORG",
      "LLM_PROVIDER",
      "LLM_API_KEY",
    ]);
    expect(setLegacyVariables({ LLM_PROVIDER: "openrouter" })).toEqual([]);
  });
});

describe("reading the allow list", () => {
  it("reads the logins, the organization and the OAuth app", () => {
    const legacy = readLegacyEnvironment({
      ALLOWED_GITHUB_LOGINS: "alice, bob:42",
      ALLOWED_GITHUB_ORG: "acme",
      GITHUB_OAUTH_CLIENT_ID: "x",
    });

    expect([...legacy.access.logins]).toEqual(["alice", "bob"]);
    expect(legacy.organization).toBe("acme");
    expect(legacy.oauthApp).toBe(true);
  });
});
