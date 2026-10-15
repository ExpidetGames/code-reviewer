// SPDX-License-Identifier: Apache-2.0

// The setup code of a serverless deployment, kept in the database (#321; docs/decisions/
// 0001-editions-setup-and-accounts.md, section 2.2). The in-memory store (code-store.ts) cannot work there:
// every request may reach another instance, and none of them lives long. The rules are the same ones:
//
// - 6 digits from a cryptographically secure source, valid for 60 minutes;
// - about 5 attempts per minute, now for the whole deployment (counted in the database);
// - after 10 wrong attempts the code locks, until a new one is issued with `pnpm setup-code`;
// - single use, also across instances: the database accepts the correct code once;
// - only a keyed hash is stored (HMAC-SHA256 with a key derived from `APP_SECRET`, over the id of the
//   issuance and the code), so a copy of the database alone cannot tell the code. The code is shown once,
//   on the terminal of the operator who ran the command (setup-code-cli.ts), never in a response or a log.
//
// The counters are one statement each (src/db/repositories/setup-codes-repository.ts); this module
// compares the code and decides the answer. It never logs a code or a submitted value.
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import type { Kysely } from "kysely";
import { deriveKey } from "../crypto/keys.ts";
import {
  createSetupCodesRepository,
  type SetupCodeRow,
} from "../db/repositories/setup-codes-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  SETUP_ATTEMPT_WINDOW_MS,
  SETUP_ATTEMPTS_PER_WINDOW,
  SETUP_CODE_LENGTH,
  SETUP_CODE_TTL_MS,
  SETUP_MAX_FAILURES,
  type SetupCodeAttempt,
  type SetupCodeGuard,
} from "./code-store.ts";

export type IssuedSetupCode = {
  /** Shown once to the operator; stored nowhere. */
  code: string;
  issueId: string;
  expiresAt: Date;
};

export type DatabaseSetupCodeStore = SetupCodeGuard & {
  /** Makes a new code, replaces the old one with its counters, and returns the code once. */
  issue(): Promise<IssuedSetupCode>;
};

type StoreOptions = {
  db: Kysely<Database>;
  /** The master key: the hash key is derived from it, so the table alone cannot be checked against. */
  appSecret: string;
  now?: () => number;
  /** Replaces the secure random source; only tests pass this. */
  randomCode?: () => string;
  log?: (line: string) => void;
};

function secureCode(): string {
  return String(randomInt(0, 10 ** SETUP_CODE_LENGTH)).padStart(
    SETUP_CODE_LENGTH,
    "0",
  );
}

function keyedHash(appSecret: string, issueId: string, code: string): Buffer {
  return createHmac("sha256", deriveKey(appSecret, "setup-code"))
    .update(`${issueId}:${code}`, "utf8")
    .digest();
}

/** Whether a stored hash is the hash of `submitted`: same length, constant time. */
function matches(
  appSecret: string,
  row: SetupCodeRow,
  submitted: unknown,
): boolean {
  const candidate = keyedHash(
    appSecret,
    row.id,
    typeof submitted === "string" ? submitted.trim() : "",
  );
  const stored = Buffer.from(row.codeHash, "hex");
  return (
    stored.length === candidate.length && timingSafeEqual(candidate, stored)
  );
}

export function createDatabaseSetupCodeStore({
  db,
  appSecret,
  now = Date.now,
  randomCode = secureCode,
  log = (line) => console.error(line),
}: StoreOptions): DatabaseSetupCodeStore {
  const codes = createSetupCodesRepository(db);

  // The reason is not repeated: an error of the driver can carry a connection string or a statement.
  function unavailable(): void {
    log(
      "[setup] SETUP_CODE_STORE_UNAVAILABLE: the setup code could not be read from the database (is the schema migrated? run pnpm migrate).",
    );
  }

  async function attempt(submitted: unknown): Promise<SetupCodeAttempt> {
    const at = new Date(now());
    const row = await codes.current();
    if (row === null) return { ok: false, error: "setup_unavailable" };

    // Takes a place in the window and counts the attempt as wrong, before anything is compared.
    const counted = await codes.countAttempt(row.id, {
      now: at,
      windowMs: SETUP_ATTEMPT_WINDOW_MS,
      attemptsPerWindow: SETUP_ATTEMPTS_PER_WINDOW,
      maxFailures: SETUP_MAX_FAILURES,
    });
    if (counted === null) return refusal(await codes.current(), at);

    if (counted.usedAt !== null) return { ok: false, error: "code_used" };
    if (!matches(appSecret, counted, submitted))
      return { ok: false, error: "invalid_code" };

    // Another instance may have used the code since: the database accepts it once.
    if (!(await codes.consume(counted.id, at)))
      return { ok: false, error: "code_used" };
    return { ok: true, issueId: counted.id };
  }

  /** Why the attempt did not count, in the order the in-memory store checks. */
  function refusal(row: SetupCodeRow | null, at: Date): SetupCodeAttempt {
    if (row === null) return { ok: false, error: "setup_unavailable" };
    if (row.failures >= SETUP_MAX_FAILURES)
      return { ok: false, error: "setup_locked" };
    if (at.getTime() >= row.expiresAt.getTime())
      return { ok: false, error: "code_expired" };
    const windowEnd =
      (row.windowStartedAt?.getTime() ?? at.getTime()) +
      SETUP_ATTEMPT_WINDOW_MS;
    return {
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowEnd - at.getTime()) / 1000),
      ),
    };
  }

  return {
    async issue() {
      const code = randomCode();
      const issueId = randomBytes(16).toString("hex");
      const createdAt = new Date(now());
      const expiresAt = new Date(createdAt.getTime() + SETUP_CODE_TTL_MS);
      await codes.replace({
        id: issueId,
        codeHash: keyedHash(appSecret, issueId, code).toString("hex"),
        createdAt,
        expiresAt,
      });
      return { code, issueId, expiresAt };
    },

    async attempt(submitted) {
      try {
        return await attempt(submitted);
      } catch {
        unavailable();
        return { ok: false, error: "setup_unavailable" };
      }
    },

    async currentIssueId() {
      try {
        return (await codes.current())?.id ?? null;
      } catch {
        unavailable();
        return null;
      }
    },

    async invalidate() {
      await codes.clear();
    },
  };
}
