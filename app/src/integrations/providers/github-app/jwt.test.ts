// Pins down the app JWT: the claims GitHub requires and a signature only the app's key can make.
import { createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testAppKeys } from "../../../test-support/github-app.ts";
import { createAppJwt } from "./jwt.ts";

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("the app JWT", () => {
  const { privateKey, publicKey } = testAppKeys();
  const nowMs = Date.UTC(2026, 9, 10, 12, 0, 0);

  it("carries the app id as issuer and expires within ten minutes", () => {
    const jwt = createAppJwt({ appId: "424242", privateKey, nowMs });
    const [header, payload] = jwt.split(".") as [string, string, string];

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload) as { iss: string; iat: number; exp: number };
    const now = nowMs / 1000;
    expect(claims.iss).toBe("424242");
    expect(claims.iat).toBeLessThan(now);
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("is signed with the private key so the public key verifies it", () => {
    const jwt = createAppJwt({ appId: "424242", privateKey, nowMs });
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];

    const valid = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));

    expect(valid).toBe(true);
  });
});
