// SPDX-License-Identifier: Apache-2.0

// Dummy GitHub App credentials for tests: a fresh RSA key pair per test process (never a real key)
// and the environment variables built from it. The public half is what the fake GitHub checks JWTs
// with. Knows nothing about the provider, so any test may use it.
import { generateKeyPairSync } from "node:crypto";

export const TEST_APP_ID = "424242";
export const TEST_APP_SLUG = "code-reviewer-test";
export const TEST_WEBHOOK_SECRET = "test-webhook-secret-value";

let keys: { privateKey: string; publicKey: string } | undefined;

export function testAppKeys(): { privateKey: string; publicKey: string } {
  keys ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return keys;
}

/** The GitHub App environment variables for tests; `overrides` replaces or (with undefined) removes. */
export function testGithubAppEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: TEST_APP_ID,
    GITHUB_APP_SLUG: TEST_APP_SLUG,
    GITHUB_APP_PRIVATE_KEY: testAppKeys().privateKey,
    GITHUB_APP_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    // The master key: the credential store of the running server reads the database first and needs it
    // before it falls back to the variables above.
    APP_SECRET: "test-app-secret-0123456789-0123456789-abc",
    ...overrides,
  };
}
