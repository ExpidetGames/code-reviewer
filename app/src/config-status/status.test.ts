// SPDX-License-Identifier: Apache-2.0

// Pins down what the pages may know about the instance's configuration: the GitHub App status comes
// from the credentials the server read (`githubAppStatusOf`), never from the environment, and the
// instance LLM part is the model options only. Never a value: the private key, the webhook secret and
// the LLM key must not be in anything this returns.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GithubSnapshot } from "../github-config/credentials.ts";
import { loadGithubAppConfig } from "../integrations/registry.ts";
import {
  configAudienceOf,
  describeConfigStatus,
  githubAppStatusOf,
  installUrlOf,
  statusForMembers,
} from "./status.ts";

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const LLM_KEY = "dummy-llm-key-0123456789";
const SECRET = "dummy-webhook-secret-value";

function snapshotOf(app: GithubSnapshot["app"], slug: string | null) {
  return {
    source: app.ok ? "database" : "none",
    stored: null,
    slug,
    app,
    userAuthorization: { state: "none" },
    updatedBy: null,
    updatedAt: null,
  } satisfies GithubSnapshot;
}

const CONFIGURED = githubAppStatusOf(
  snapshotOf(
    {
      ok: true,
      config: loadGithubAppConfig({
        GITHUB_APP_ID: "424242",
        GITHUB_APP_SLUG: "code-reviewer-test",
        GITHUB_APP_PRIVATE_KEY: KEY,
        GITHUB_APP_WEBHOOK_SECRET: SECRET,
      }),
    },
    "code-reviewer-test",
  ),
);

describe("the GitHub App status from the credentials", () => {
  it("reports a stored App as configured with its slug", () => {
    expect(CONFIGURED).toEqual({
      configured: true,
      slug: "code-reviewer-test",
    });
  });

  it("names the fields that are missing or not usable, never a value", () => {
    expect(
      githubAppStatusOf(
        snapshotOf(
          { ok: false, kind: "missing", fields: ["github_app_private_key"] },
          null,
        ),
      ),
    ).toEqual({
      configured: false,
      kind: "missing",
      variables: ["github_app_private_key"],
      slug: null,
    });
  });
});

describe("describing the configuration for the pages", () => {
  // #159-T01
  it("takes the GitHub App from the given status and never from the environment", () => {
    const status = describeConfigStatus(
      {
        GITHUB_APP_ID: "1",
        GITHUB_APP_SLUG: "../evil",
        GITHUB_APP_PRIVATE_KEY: "not a key",
        LLM_PROVIDER: "openrouter",
        LLM_API_KEY: LLM_KEY,
      },
      { configured: true, slug: "from-the-database" },
    );

    expect(status.githubApp).toEqual({
      configured: true,
      slug: "from-the-database",
    });
    // The legacy provider and key are not read: the instance LLM part is always configured.
    expect(status.llm).toEqual({
      configured: true,
      provider: "openrouter",
      model: "anthropic/claude-haiku-5.5",
      warnings: [],
    });
  });

  // CR-34-T09 (a wrong option is still a warning)
  it("reports a wrong model option as a warning with the variable name", () => {
    const status = describeConfigStatus(
      { LLM_MODEL: "not a model" },
      { configured: false, kind: "missing", variables: [], slug: null },
    );

    expect(status.llm.warnings).toEqual([
      { code: "LLM_MODEL_INVALID", variable: "LLM_MODEL" },
    ]);
  });

  // CR-34-T09, CR-34-T10
  it("contains no secret value, however the configuration looks", () => {
    const text = JSON.stringify(
      describeConfigStatus(
        {
          LLM_API_KEY: LLM_KEY,
          LLM_MODEL: `bad model ${LLM_KEY}`,
          LLM_MAX_TOKENS: LLM_KEY,
        },
        { configured: true, slug: "code-reviewer-test" },
      ),
    );

    expect(text).not.toContain(LLM_KEY);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("PRIVATE KEY");
  });

  it("offers no install address while the slug is missing or not a name", () => {
    expect(installUrlOf({ configured: true, slug: "" })).toBeNull();
    expect(installUrlOf({ configured: true, slug: "../evil" })).toBeNull();
  });

  // CR-34-T02
  it("builds the install address from the slug", () => {
    expect(installUrlOf(CONFIGURED)).toBe(
      "https://github.com/apps/code-reviewer-test/installations/new",
    );
  });
});

describe("the status for members", () => {
  // #101-WM-08
  it("keeps whether each part works and nothing else: no variable, slug, provider, model or warning", () => {
    const broken = describeConfigStatus(
      { LLM_MODEL: "not a model" },
      {
        configured: false,
        kind: "missing",
        variables: ["github_app_private_key"],
        slug: "code-reviewer-test",
      },
    );
    const working = describeConfigStatus(
      { LLM_MODEL: "vendor/secret-model" },
      CONFIGURED,
    );

    expect(statusForMembers(broken)).toEqual({
      githubApp: {
        configured: false,
        kind: "missing",
        variables: [],
        slug: null,
      },
      llm: {
        configured: true,
        provider: "openrouter",
        model: "",
        warnings: [],
      },
    });
    const shown = statusForMembers(working);
    expect(shown.githubApp.configured).toBe(true);
    expect(shown.llm.configured).toBe(true);
    expect(JSON.stringify(shown)).not.toMatch(/secret-model|LLM_|GITHUB_APP/);
  });

  // #101-WM-08
  it("is for everybody but the instance admin", () => {
    expect(configAudienceOf({ isInstanceAdmin: true })).toBe("operator");
    expect(configAudienceOf({ isInstanceAdmin: false })).toBe("member");
  });
});
