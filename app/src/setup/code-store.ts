// The setup code and everything that protects it, kept in the memory of one process
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.2):
//
// - a fresh 6-digit code from a cryptographically secure source, of which only a keyed hash is kept;
// - valid for 60 minutes, then the app has to be restarted;
// - about 5 attempts per minute, counted per process and not per address (a reverse proxy makes
//   addresses unreliable, and only the operator is meant to use this);
// - after 10 wrong attempts the store locks until the process is restarted: no automatic rotation,
//   which would let an attacker invalidate the operator's code at will;
// - single use: a correct code is consumed.
//
// Nothing here is stored in the database, on purpose: the code proves access to the server's log,
// and a second app instance has its own code and its own counters (so the setup is done with one
// instance running). The store never logs; the one line that shows the code is printed by start.ts.
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

export const SETUP_CODE_LENGTH = 6;
export const SETUP_CODE_TTL_MS = 60 * 60 * 1000;
export const SETUP_ATTEMPTS_PER_WINDOW = 5;
export const SETUP_ATTEMPT_WINDOW_MS = 60 * 1000;
export const SETUP_MAX_FAILURES = 10;

export type SetupCodeAttempt =
  | {
      ok: true;
      /** Identifies this issuance of the code; the setup session is bound to it. */
      issueId: string;
    }
  | {
      ok: false;
      error:
        | "invalid_code"
        | "code_expired"
        | "code_used"
        | "setup_locked"
        | "rate_limited"
        | "setup_unavailable";
      /** For `rate_limited`: whole seconds until the next attempt counts. */
      retryAfterSeconds?: number;
    };

export type SetupCodeStore = {
  /** Makes a new code, forgets the old state (a restart does the same), and returns the code once. */
  issue(): string;
  /** Checks a submitted code. Counts the attempt; a correct code is consumed. */
  attempt(submitted: unknown): SetupCodeAttempt;
  /** The id of the current issuance, or null before a code was issued. Binds the setup session. */
  currentIssueId(): string | null;
  /** Forgets the code (the setup is complete). */
  invalidate(): void;
};

type StoreOptions = {
  now?: () => number;
  /** Replaces the secure random source; only tests pass this. */
  randomCode?: () => string;
};

type State = {
  issueId: string;
  hashKey: Buffer;
  /** Keyed hash of the code; null once the code is consumed or invalidated. */
  hash: Buffer | null;
  issuedAt: number;
  failures: number;
  locked: boolean;
  windowStartedAt: number;
  attemptsInWindow: number;
};

function secureCode(): string {
  return String(randomInt(0, 10 ** SETUP_CODE_LENGTH)).padStart(
    SETUP_CODE_LENGTH,
    "0",
  );
}

function keyedHash(key: Buffer, code: string): Buffer {
  return createHmac("sha256", key).update(code, "utf8").digest();
}

export function createSetupCodeStore({
  now = Date.now,
  randomCode = secureCode,
}: StoreOptions = {}): SetupCodeStore {
  let state: State | null = null;

  return {
    issue() {
      const code = randomCode();
      const hashKey = randomBytes(32);
      state = {
        issueId: randomBytes(16).toString("hex"),
        hashKey,
        hash: keyedHash(hashKey, code),
        issuedAt: now(),
        failures: 0,
        locked: false,
        windowStartedAt: 0,
        attemptsInWindow: 0,
      };
      return code;
    },

    attempt(submitted) {
      if (state === null) return { ok: false, error: "setup_unavailable" };
      const current = state;
      const at = now();

      // A locked store answers the same to every attempt, however it is counted.
      if (current.locked) return { ok: false, error: "setup_locked" };

      // An old code can no longer be used, and guessing it would be pointless.
      if (at - current.issuedAt >= SETUP_CODE_TTL_MS)
        return { ok: false, error: "code_expired" };

      // About 5 attempts per minute for the whole process.
      if (at - current.windowStartedAt >= SETUP_ATTEMPT_WINDOW_MS) {
        current.windowStartedAt = at;
        current.attemptsInWindow = 0;
      }
      if (current.attemptsInWindow >= SETUP_ATTEMPTS_PER_WINDOW) {
        const waitMs = current.windowStartedAt + SETUP_ATTEMPT_WINDOW_MS - at;
        return {
          ok: false,
          error: "rate_limited",
          retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        };
      }
      current.attemptsInWindow += 1;

      if (current.hash === null) return { ok: false, error: "code_used" };

      // Compared as keyed hashes of equal length, in constant time. A submission that is not six
      // digits is hashed like any other value and simply does not match; it counts as a failure.
      const candidate = keyedHash(
        current.hashKey,
        typeof submitted === "string" ? submitted.trim() : "",
      );
      if (!timingSafeEqual(candidate, current.hash)) {
        current.failures += 1;
        if (current.failures >= SETUP_MAX_FAILURES) current.locked = true;
        return { ok: false, error: "invalid_code" };
      }

      current.hash = null;
      return { ok: true, issueId: current.issueId };
    },

    currentIssueId() {
      return state?.issueId ?? null;
    },

    invalidate() {
      if (state === null) return;
      state.hash = null;
    },
  };
}
