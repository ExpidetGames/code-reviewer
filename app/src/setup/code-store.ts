// SPDX-License-Identifier: LicenseRef-Proprietary

// What the setup code is made of, and the shape its store answers with (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.2). The code lives in the database (database-code-store.ts, #321) because the next request may reach another
// serverless instance:
//
// - a fresh 6-digit code from a cryptographically secure source, of which only a keyed hash is kept;
// - valid for 60 minutes, then `pnpm setup-code` makes a new one;
// - about 5 attempts per minute for the whole deployment;
// - after 10 wrong attempts the store locks until a new code is made;
// - single use: a correct code is consumed.

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

/**
 * What the setup routes need from a code store: the database store (database-code-store.ts) answers with
 * promises. The routes `await` every call.
 */
export type SetupCodeGuard = {
  attempt(submitted: unknown): SetupCodeAttempt | Promise<SetupCodeAttempt>;
  currentIssueId(): string | null | Promise<string | null>;
  invalidate(): void | Promise<void>;
};
