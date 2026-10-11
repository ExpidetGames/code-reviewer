// The wiring of the running server for the admin portal: the settings service on the server's database,
// the secret store, and the facts the portal shows. Server code only.
import "server-only";
import { githubSignInConfigured } from "../auth/sign-in-methods.ts";
import { getDatabase } from "../db/startup.ts";
import { getSecretStore } from "../secrets/shared.ts";
import { createAdminService, type AdminService } from "./service.ts";

export function getAdminService(): AdminService {
  return createAdminService({
    db: getDatabase(),
    secrets: getSecretStore(),
    // Sign-in with GitHub exists while the GitHub OAuth app is configured. The GitHub issue of the
    // admin portal moves the configuration into the database and changes only this line.
    githubConfigured: () => githubSignInConfigured(process.env),
    // The mail settings come with the SMTP issue; until then there is no mail server.
    mailConfigured: () => Promise.resolve(false),
  });
}
