// SPDX-License-Identifier: Apache-2.0

// Pins down how the GitHub App settings are read from the environment: what is required, which
// problems are reported by variable name only, and that the secrets stay out of logs and JSON.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadGithubAppConfig } from "./config.ts";
import { GithubAppConfigError } from "./errors.ts";
import { createAppJwt } from "./jwt.ts";

const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const { privateKey } = keyPair;
const keyBody = privateKey.split("\n")[1]!;

const directory = mkdtempSync(join(tmpdir(), "cr-app-config-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const keyPath = join(directory, "app.pem");
writeFileSync(keyPath, privateKey);

const complete = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "code-reviewer-dev",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_WEBHOOK_SECRET: "whsec-dummy-value",
};

function failureOf(env: Record<string, string | undefined>) {
  try {
    loadGithubAppConfig(env);
  } catch (error) {
    return error;
  }
  throw new Error("expected the configuration to be refused");
}

describe("loading the GitHub App configuration", () => {
  it("reads the app id, slug, key and webhook secret and defaults to the public GitHub API", () => {
    const config = loadGithubAppConfig(complete);

    expect(config).toMatchObject({
      appId: "123456",
      slug: "code-reviewer-dev",
      apiBaseUrl: "https://api.github.com",
    });
    expect(config.webhookSecret).toBe("whsec-dummy-value");
    expect(config.privateKey).toBe(privateKey.trim());
  });

  // CR-38 review: the guide says the inline key wins when both are set.
  it("takes the inline key when the path is given too", () => {
    const config = loadGithubAppConfig({
      ...complete,
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_APP_PRIVATE_KEY_PATH: join(directory, "does-not-exist.pem"),
    });

    expect(config.privateKey).toBe(privateKey.trim());
  });

  it("reads the private key from a file when only its path is given", () => {
    const config = loadGithubAppConfig({
      ...complete,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    });

    expect(config.privateKey).toBe(privateKey.trim());
  });

  // CR-38-T02
  it("turns real line breaks and escaped backslash n into the same key, and a JWT signed with it verifies", () => {
    const withBreaks = privateKey.trim();
    const escaped = withBreaks.replace(/\n/g, "\\n");

    const fromBreaks = loadGithubAppConfig({
      ...complete,
      GITHUB_APP_PRIVATE_KEY: withBreaks,
    }).privateKey;
    const fromEscaped = loadGithubAppConfig({
      ...complete,
      GITHUB_APP_PRIVATE_KEY: escaped,
    }).privateKey;

    expect(fromEscaped).toBe(fromBreaks);
    const jwt = createAppJwt({
      appId: "123456",
      privateKey: fromEscaped,
      nowMs: 1_700_000_000_000,
    });
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(keyPair.publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("accepts a key whose line breaks were replaced by backslash n or by spaces", () => {
    const escaped = privateKey.trim().replace(/\n/g, "\\n");
    const singleLine = privateKey.trim().replace(/\n/g, " ");

    expect(
      loadGithubAppConfig({ ...complete, GITHUB_APP_PRIVATE_KEY: escaped })
        .privateKey,
    ).toBe(privateKey.trim());
    expect(
      loadGithubAppConfig({ ...complete, GITHUB_APP_PRIVATE_KEY: singleLine })
        .privateKey,
    ).toBe(privateKey.trim());
  });

  it("uses a test API base URL without a trailing slash when test endpoints are allowed", () => {
    const config = loadGithubAppConfig({
      ...complete,
      GITHUB_API_BASE_URL: "http://127.0.0.1:4010/",
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    });

    expect(config.apiBaseUrl).toBe("http://127.0.0.1:4010");
  });

  it("refuses another API base URL unless test endpoints are allowed, naming both variables", () => {
    for (const allow of [undefined, "false", "1", "TRUE"]) {
      const error = failureOf({
        ...complete,
        GITHUB_API_BASE_URL: "http://127.0.0.1:4010",
        ALLOW_TEST_GITHUB_ENDPOINTS: allow,
      });

      expect(error).toMatchObject({
        code: "GITHUB_APP_CONFIG_INVALID",
        variables: ["GITHUB_API_BASE_URL", "ALLOW_TEST_GITHUB_ENDPOINTS"],
      });
    }
  });

  it("accepts the public GitHub API address given explicitly without the flag", () => {
    const config = loadGithubAppConfig({
      ...complete,
      GITHUB_API_BASE_URL: "https://api.github.com/",
    });

    expect(config.apiBaseUrl).toBe("https://api.github.com");
  });

  it("keeps whitespace of the webhook secret", () => {
    const config = loadGithubAppConfig({
      ...complete,
      GITHUB_APP_WEBHOOK_SECRET: " secret with edges ",
    });

    expect(config.webhookSecret).toBe(" secret with edges ");
  });

  // CR-21-T10
  it("names every missing variable and no value when settings are absent", () => {
    const error = failureOf({
      GITHUB_APP_ID: "123456",
      GITHUB_APP_WEBHOOK_SECRET: "whsec-dummy-value",
    });

    expect(error).toBeInstanceOf(GithubAppConfigError);
    expect(error).toMatchObject({
      code: "GITHUB_APP_CONFIG_INVALID",
      variables: [
        "GITHUB_APP_SLUG",
        "GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH)",
      ],
    });
    expect((error as Error).message).toContain("GITHUB_APP_SLUG");
    expect((error as Error).message).not.toContain("whsec-dummy-value");
  });

  it("treats blank values like missing ones", () => {
    const error = failureOf({ ...complete, GITHUB_APP_ID: "   " });

    expect(error).toMatchObject({ variables: ["GITHUB_APP_ID"] });
  });

  // CR-21-T10
  it("refuses a key that is not a valid PEM without echoing any part of it", () => {
    const error = failureOf({
      ...complete,
      GITHUB_APP_PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----\n${keyBody}\n-----END RSA PRIVATE KEY-----`,
    });

    expect(error).toMatchObject({
      code: "GITHUB_APP_CONFIG_INVALID",
      variables: ["GITHUB_APP_PRIVATE_KEY"],
    });
    expect((error as Error).message).not.toContain(keyBody);
    expect((error as Error).message).not.toContain("whsec-dummy-value");
  });

  it("refuses a key that is not an RSA key", () => {
    const ec = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    expect(
      failureOf({ ...complete, GITHUB_APP_PRIVATE_KEY: ec.privateKey }),
    ).toMatchObject({ variables: ["GITHUB_APP_PRIVATE_KEY"] });
  });

  it("names the path variable when the key file cannot be read", () => {
    const error = failureOf({
      ...complete,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_PRIVATE_KEY_PATH: join(directory, "missing.pem"),
    });

    expect(error).toMatchObject({ variables: ["GITHUB_APP_PRIVATE_KEY_PATH"] });
  });

  it("refuses an API base URL that is not an http(s) URL", () => {
    const error = failureOf({
      ...complete,
      GITHUB_API_BASE_URL: "ftp://x",
      ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    });

    expect(error).toMatchObject({
      variables: ["GITHUB_API_BASE_URL", "ALLOW_TEST_GITHUB_ENDPOINTS"],
    });
  });

  it("keeps the key and the webhook secret out of JSON and enumeration", () => {
    const config = loadGithubAppConfig(complete);

    const text = JSON.stringify(config) + Object.values(config).join(",");

    expect(text).not.toContain(keyBody);
    expect(text).not.toContain("whsec-dummy-value");
  });
});
