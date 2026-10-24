// SPDX-License-Identifier: LicenseRef-Proprietary

// The fake SMTP server of the app's tests (fakes/smtp): a real SMTP server on a loopback port that keeps
// what it is sent, closed after the test. The app's mail sender talks to it over the real protocol, so a
// test sees the mail that would have left the building, byte for byte.
import {
  startSmtpFake,
  type SmtpFake,
  type SmtpFakeOptions,
} from "../../../fakes/smtp/server.ts";
import { cleanUpAfterTest } from "./test-database.ts";

/** The login the fake accepts when a test asks for authentication (dummy values). */
export const TEST_SMTP_USER = "mailer";
export const TEST_SMTP_PASSWORD = "smtp-test-password-0123456789";

export async function startTestSmtp(
  options: SmtpFakeOptions = {},
): Promise<SmtpFake> {
  const smtp = await startSmtpFake(options);
  cleanUpAfterTest(() => smtp.close());
  return smtp;
}
