// SPDX-License-Identifier: Apache-2.0

// The credentials of a claim (#320). A legacy claim hands the runner a lease token, a split claim
// (`worker_credential`) hands the Dispatcher a per-job credential that only the Worker uses. Both are
// 256 random bits. The credential is a secret that appears in exactly one answer, the split claim
// response; what the database keeps for it is a hash, in the column of the lease token, so every
// statement that is fenced by the lease token (heartbeat, complete, release, cancel) is fenced by the
// credential of the claim without a second column and without the secret ever being stored.
//
// Nothing here logs or compares a secret in variable time: a lookup is by hash of a 256 bit random
// value, which carries no information about a near miss.
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { bearerTokenOf } from "../runner-api/token-auth.ts";

/** `WorkerCredential` in contracts/runner-api.v1.json. */
export const WORKER_CREDENTIAL_PREFIX = "crj_";
export const WORKER_CREDENTIAL_PATTERN = /^crj_[A-Za-z0-9_-]{43}$/;

/** What the database stores for a credential; a legacy lease token never has this form. */
const STORED_PREFIX = "wc1:";
const STORED_PATTERN = /^wc1:[0-9a-f]{64}$/;

/** 256 random bits as base64url without padding (43 characters). */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The per-job credential: shown once, in the split claim response. */
export function newWorkerCredential(): string {
  return `${WORKER_CREDENTIAL_PREFIX}${randomToken()}`;
}

/** The lease token of a legacy claim (256 bits; it was a UUID of 122 bits before #320). */
export function newLeaseToken(): string {
  return randomToken();
}

/**
 * What the queue stores and fences on for the credential: a prefixed SHA-256. The credential has 256
 * bits of entropy, so a fast hash is enough and the hash cannot be turned back into it.
 */
export function workerLeaseToken(credential: string): string {
  return `${STORED_PREFIX}${createHash("sha256").update(credential, "utf8").digest("hex")}`;
}

/** True for the stored form of a credential, false for the lease token of a legacy claim. */
export function isWorkerLeaseToken(stored: string): boolean {
  return STORED_PATTERN.test(stored);
}

/**
 * The credential of an `Authorization: Bearer` header, or null when the header is missing, uses another
 * scheme or does not carry something of the form of a credential (the dispatcher credential, a lease
 * token, a credential of another length).
 */
export function bearerWorkerCredential(header: string | null): string | null {
  const token = bearerTokenOf(header);
  return token !== null && WORKER_CREDENTIAL_PATTERN.test(token) ? token : null;
}
