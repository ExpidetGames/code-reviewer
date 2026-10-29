// SPDX-License-Identifier: LicenseRef-Proprietary

// The wiring of the running server for the admin portal: the settings service on the server's database,
// the secret store, the mail server settings and the facts the portal shows. Server code only.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { isGithubSignInConfigured } from "../github-config/shared.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { llmApiBaseUrl } from "../llm/endpoint.ts";
import { createOperatorKeyTestService } from "../llm/operator-key-test.ts";
import { getSmtpConfigStore } from "../mail/shared.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { createTestMailService } from "../mail/test-mail.ts";
import { getCatalogService } from "../model-catalog/shared.ts";
import { getSecretStore } from "../secrets/shared.ts";
import { SECRET_NAMES } from "./secret-names.ts";
import { createAdminService, type AdminService } from "./service.ts";

export function getAdminService(): AdminService {
  const smtp = getSmtpConfigStore();
  return createAdminService({
    db: getDatabase(),
    secrets: getSecretStore(SECRET_NAMES),
    smtp,
    testMail: createTestMailService({
      config: smtp,
      rateLimits: createRateLimitsRepository(getDatabase()),
      // The address in the test mail is the configured one, never a request header.
      baseUrl: loadAuthConfig(process.env).baseUrl,
      product: getProductIdentity(),
    }),
    // The Test button of the operator's keys: counters of its own, and the provider's own address (src/llm/endpoint.ts;
    // the test stack may point it at the fake LLM), never one from a request.
    operatorKeyTest: createOperatorKeyTestService({
      rateLimits: createRateLimitsRepository(getDatabase()),
      baseUrlOf: (provider) => llmApiBaseUrl(process.env, provider).url,
    }),
    // The overview's numbers of the model catalog (#429).
    catalogSummary: () => getCatalogService().summary(),
    // Sign-in with GitHub exists while the GitHub App's user authorization is configured, read from the
    // database on every call.
    githubConfigured: isGithubSignInConfigured,
  });
}
