// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server for the admin portal: the settings service on the server's database,
// the secret store, the mail server settings and the facts the portal shows. Server code only.
import "server-only";
import { getAccessPolicy } from "../auth/access-runtime.ts";
import { loadAuthConfig } from "../auth/config.ts";
import { githubSignInConfigured } from "../auth/sign-in-methods.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getSmtpConfigStore } from "../mail/shared.ts";
import { createTestMailService } from "../mail/test-mail.ts";
import { getSecretStore } from "../secrets/shared.ts";
import { createAdminService, type AdminService } from "./service.ts";

export function getAdminService(): AdminService {
  const smtp = getSmtpConfigStore();
  return createAdminService({
    db: getDatabase(),
    secrets: getSecretStore(),
    smtp,
    testMail: createTestMailService({
      config: smtp,
      rateLimits: createRateLimitsRepository(getDatabase()),
      // The address in the test mail is the configured one, never a request header.
      baseUrl: loadAuthConfig(process.env).baseUrl,
    }),
    // Sign-in with GitHub exists while the GitHub OAuth app is configured. The GitHub issue of the
    // admin portal moves the configuration into the database and changes only this line.
    githubConfigured: () => githubSignInConfigured(process.env),
    accessPolicy: (user) => getAccessPolicy()(user),
  });
}
