// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  bearerWorkerCredential,
  isWorkerLeaseToken,
  newLeaseToken,
  newWorkerCredential,
  workerLeaseToken,
  WORKER_CREDENTIAL_PATTERN,
} from "./worker-credential.ts";

describe("the per-job credential", () => {
  // #320-T14
  it("is crj_ and 256 random bits in base64url without padding", () => {
    const credential = newWorkerCredential();

    expect(credential).toMatch(WORKER_CREDENTIAL_PATTERN);
    expect(credential).toMatch(/^crj_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(credential.slice(4), "base64url")).toHaveLength(32);
  });

  // #320-T14
  it("is different every time", () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => newWorkerCredential()),
    );

    expect(seen.size).toBe(200);
  });

  // #320-T14
  it("is stored as a hash that is not the credential, is stable and tells itself apart from a lease token", () => {
    const credential = newWorkerCredential();

    const stored = workerLeaseToken(credential);

    expect(stored).toMatch(/^wc1:[0-9a-f]{64}$/);
    expect(stored).toBe(workerLeaseToken(credential));
    expect(stored).not.toContain(credential.slice(4));
    expect(workerLeaseToken(newWorkerCredential())).not.toBe(stored);
    expect(isWorkerLeaseToken(stored)).toBe(true);
    expect(isWorkerLeaseToken(newLeaseToken())).toBe(false);
    expect(isWorkerLeaseToken(credential)).toBe(false);
  });

  // #320-T14
  it("has a legacy lease token of 256 bits that is no credential", () => {
    const token = newLeaseToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toMatch(WORKER_CREDENTIAL_PATTERN);
    expect(newLeaseToken()).not.toBe(token);
  });

  // #320-T04
  it.each([
    ["no header", null],
    ["another scheme", `Basic crj_${"A".repeat(43)}`],
    [
      "the dispatcher credential",
      "Bearer test-runner-token-4f9c2a7e1b-0d58a3c6e9f2",
    ],
    ["a credential that is too short", `Bearer crj_${"A".repeat(42)}`],
    ["a credential that is too long", `Bearer crj_${"A".repeat(44)}`],
    ["a credential with a bad character", `Bearer crj_${"A".repeat(42)}+`],
    ["a wrong prefix", `Bearer crx_${"A".repeat(43)}`],
    ["a lease token", `Bearer ${"A".repeat(43)}`],
  ])("is not read from %s", (_name, header) => {
    expect(bearerWorkerCredential(header)).toBeNull();
  });

  it("is read from a bearer header", () => {
    const credential = newWorkerCredential();

    expect(bearerWorkerCredential(`Bearer ${credential}`)).toBe(credential);
    expect(bearerWorkerCredential(`bearer  ${credential}`)).toBe(credential);
  });
});
