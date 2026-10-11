// SPDX-License-Identifier: Apache-2.0

// What the server says about mail when it starts. The only thing to say today: the test stack's file outbox
// is switched on (src/mail/outbox-sender.ts), which means no mail is sent at all. Called from
// `src/instrumentation.ts`.
import { ALLOW_TEST_MAIL_OUTBOX_FLAG } from "./shared.ts";

/** Logs one warning when the variables of the test mail outbox are set. Returns whether it did. */
export function warnAboutTestMailOutbox(
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: Pick<Console, "warn"> = console,
): boolean {
  const flagSet = env[ALLOW_TEST_MAIL_OUTBOX_FLAG]?.trim() === "true";
  const fileSet = Boolean(env.TEST_MAIL_OUTBOX_FILE?.trim());
  if (!flagSet && !fileSet) return false;
  log.warn(
    flagSet && fileSet
      ? "[mail] TEST_MAIL_OUTBOX_ACTIVE: mail is written to a file and NOT sent (ALLOW_TEST_MAIL_OUTBOX and TEST_MAIL_OUTBOX_FILE are set). This is for the test stack only; unset both in a real deployment."
      : "[mail] TEST_MAIL_OUTBOX_INCOMPLETE: only one of ALLOW_TEST_MAIL_OUTBOX and TEST_MAIL_OUTBOX_FILE is set, so it has no effect. These are for the test stack only; unset them in a real deployment.",
  );
  return true;
}
