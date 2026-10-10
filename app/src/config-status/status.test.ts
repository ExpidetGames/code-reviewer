// Pins down what the pages may know about the instance's configuration: which GitHub App variables
// are missing or wrong (by name only), whether the LLM access works, and the address people use to
// install the GitHub App. Never a value: the private key, the webhook secret and the LLM key must
// not be in anything this returns.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeConfigStatus, githubAppInstallUrl } from "./status.ts";

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const LLM_KEY = "dummy-llm-key-0123456789";
const SECRET = "dummy-webhook-secret-value";

const COMPLETE = {
  GITHUB_APP_ID: "424242",
  GITHUB_APP_SLUG: "code-reviewer-test",
  GITHUB_APP_PRIVATE_KEY: KEY,
  GITHUB_APP_WEBHOOK_SECRET: SECRET,
  LLM_PROVIDER: "openrouter",
  LLM_API_KEY: LLM_KEY,
};

describe("describing the configuration for the pages", () => {
  // CR-34-T11
  it("reports a complete configuration as working", () => {
    const status = describeConfigStatus(COMPLETE);

    expect(status.githubApp).toEqual({
      configured: true,
      slug: "code-reviewer-test",
    });
    expect(status.llm).toMatchObject({ configured: true });
  });

  // CR-34-T10
  it("names the missing GitHub App variables and nothing else", () => {
    const status = describeConfigStatus({
      ...COMPLETE,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_WEBHOOK_SECRET: "   ",
    });

    expect(status.githubApp).toEqual({
      configured: false,
      problem: "missing",
      variables: [
        "GITHUB_APP_ID",
        "GITHUB_APP_WEBHOOK_SECRET",
        "GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH)",
      ],
      slug: "code-reviewer-test",
    });
  });

  // CR-34-T10
  it("names a GitHub App variable that is present but not usable", () => {
    const status = describeConfigStatus({
      ...COMPLETE,
      GITHUB_APP_PRIVATE_KEY: "not a key",
    });

    expect(status.githubApp).toMatchObject({
      configured: false,
      problem: "invalid",
      variables: ["GITHUB_APP_PRIVATE_KEY"],
    });
  });

  // CR-34-T09
  it("reports a missing LLM key with the variable name", () => {
    const status = describeConfigStatus({
      ...COMPLETE,
      LLM_API_KEY: undefined,
    });

    expect(status.llm).toMatchObject({
      configured: false,
      issues: [{ code: "LLM_API_KEY_MISSING", variable: "LLM_API_KEY" }],
    });
  });

  // CR-34-T09, CR-34-T10
  it("contains no secret value, however the configuration looks", () => {
    const broken = JSON.stringify(
      describeConfigStatus({
        ...COMPLETE,
        GITHUB_APP_ID: "has space",
        LLM_PROVIDER: LLM_KEY,
      }),
    );
    const working = JSON.stringify(describeConfigStatus(COMPLETE));

    for (const text of [broken, working]) {
      expect(text).not.toContain(LLM_KEY);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("PRIVATE KEY");
    }
  });

  it("offers no install address while the slug is missing or not a name", () => {
    expect(githubAppInstallUrl({})).toBeNull();
    expect(githubAppInstallUrl({ GITHUB_APP_SLUG: "../evil" })).toBeNull();
  });

  // CR-34-T02
  it("builds the install address from the slug", () => {
    expect(githubAppInstallUrl(COMPLETE)).toBe(
      "https://github.com/apps/code-reviewer-test/installations/new",
    );
  });
});
