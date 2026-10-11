// SPDX-License-Identifier: Apache-2.0

// The wiring of the running server for the admin portal: the settings service on the server's database,
// the secret store, and the facts the portal shows. Server code only.
import "server-only";
import { getAccessPolicy } from "../auth/access-runtime.ts";
import { githubSignInConfigured } from "../auth/sign-in-methods.ts";
import { getDatabase } from "../db/startup.ts";
import { getMailSender } from "../mail/shared.ts";
import { getSecretStore } from "../secrets/shared.ts";
import { createAdminService, type AdminService } from "./service.ts";

export function getAdminService(): AdminService {
  return createAdminService({
    db: getDatabase(),
    secrets: getSecretStore(),
    // Sign-in with GitHub exists while the GitHub OAuth app is configured. The GitHub issue of the
    // admin portal moves the configuration into the database and changes only this line.
    githubConfigured: () => githubSignInConfigured(process.env),
    // Whether the instance can send mail: the sender of the running server (src/mail/). Until the SMTP
    // settings issue there is no mail server, except in the test stack.
    mailConfigured: () => getMailSender().isConfigured(),
    accessPolicy: (user) => getAccessPolicy()(user),
  });
}
