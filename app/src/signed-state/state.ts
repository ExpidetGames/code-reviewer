// SPDX-License-Identifier: Apache-2.0

// Signed, single-use `state` values for a round trip through the browser and GitHub (see README.md). The
// value that travels is signed and names a nonce; the nonce is a row in `signed_states` that is used up
// once. A state is bound to the person and the session that started it and to what it is for, and it
// expires. Nothing here logs, and a refusal is one code that does not say which check failed.
import { createHash, randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { signValue, verifySignedValue } from "../crypto/sign.ts";
import { formatTimestamp } from "../db/codecs.ts";
import type { Database } from "../db/schema.ts";

export const SIGNED_STATE_PURPOSES = [
  "github-manifest",
  "github-link",
] as const;
export type SignedStatePurpose = (typeof SIGNED_STATE_PURPOSES)[number];

/** How long a state can be presented after it was issued. */
export const SIGNED_STATE_TTL_MS = 10 * 60 * 1000;

export const SIGNED_STATE_ERROR_CODES = ["state_invalid"] as const;
export type SignedStateErrorCode = (typeof SIGNED_STATE_ERROR_CODES)[number];

export type IssueStateInput = {
  purpose: SignedStatePurpose;
  userId: string;
  /** The id of the session that starts it; the callback must present the same session. */
  sessionId: string;
  /** Kept server side with the nonce and handed back when the state is consumed (PKCE). */
  codeVerifier?: string;
};

export type ConsumeStateInput = {
  purpose: SignedStatePurpose;
  /** The `state` parameter as received. */
  value: string;
  userId: string;
  sessionId: string;
};

export type ConsumeStateResult =
  | { ok: true; codeVerifier: string | null }
  | { ok: false; error: SignedStateErrorCode };

export type SignedStates = {
  issue(input: IssueStateInput): Promise<string>;
  consume(input: ConsumeStateInput): Promise<ConsumeStateResult>;
};

export type SignedStatesOptions = {
  db: Kysely<Database>;
  /** The master key (`APP_SECRET`). */
  appSecret: string;
  now?: () => Date;
  ttlMs?: number;
};

type Payload = { p: string; n: string; e: number; u: string; s: string };

const REFUSED: ConsumeStateResult = { ok: false, error: "state_invalid" };

export function hashSession(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function parsePayload(text: string): Payload | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { p, n, e, u, s } = value as Record<string, unknown>;
    return typeof p === "string" &&
      typeof n === "string" &&
      typeof e === "number" &&
      typeof u === "string" &&
      typeof s === "string"
      ? { p, n, e, u, s }
      : null;
  } catch {
    return null;
  }
}

export function createSignedStates({
  db,
  appSecret,
  now = () => new Date(),
  ttlMs = SIGNED_STATE_TTL_MS,
}: SignedStatesOptions): SignedStates {
  return {
    async issue({ purpose, userId, sessionId, codeVerifier }) {
      const nonce = randomBytes(16).toString("hex");
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + ttlMs);
      const sessionHash = hashSession(sessionId);
      await db
        .insertInto("signed_states")
        .values({
          id: nonce,
          purpose,
          user_id: userId,
          session_hash: sessionHash,
          code_verifier: codeVerifier ?? null,
          created_at: formatTimestamp(issuedAt),
          expires_at: formatTimestamp(expiresAt),
          used_at: null,
        })
        .execute();
      const payload: Payload = {
        p: purpose,
        n: nonce,
        e: expiresAt.getTime(),
        u: userId,
        s: sessionHash,
      };
      return signValue(appSecret, "state-signing", JSON.stringify(payload));
    },

    async consume({ purpose, value, userId, sessionId }) {
      const text = verifySignedValue(appSecret, "state-signing", value);
      if (text === null) return REFUSED;
      const payload = parsePayload(text);
      if (payload === null) return REFUSED;
      const at = now();
      const sessionHash = hashSession(sessionId);
      // Cheap checks first, and none of them uses up the nonce: only the person and the session that
      // started the flow can use it up.
      if (
        payload.p !== purpose ||
        payload.e <= at.getTime() ||
        payload.u !== userId ||
        payload.s !== sessionHash
      )
        return REFUSED;
      // One guarded statement: the first presentation wins, on every instance.
      const row = await db
        .updateTable("signed_states")
        .set({ used_at: formatTimestamp(at) })
        .where("id", "=", payload.n)
        .where("purpose", "=", purpose)
        .where("user_id", "=", userId)
        .where("session_hash", "=", sessionHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", formatTimestamp(at))
        .returning("code_verifier")
        .executeTakeFirst();
      if (row === undefined) return REFUSED;
      return { ok: true, codeVerifier: row.code_verifier };
    },
  };
}
