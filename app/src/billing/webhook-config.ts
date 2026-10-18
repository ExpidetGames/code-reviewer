// SPDX-License-Identifier: Apache-2.0

// What the webhook needs to verify a delivery (#441, ADR 0005, 2.10): the secret of the notification destination, stored encrypted by
// the admin portal (#437), and the Paddle environment of the billing settings. Read for each request, so a rotated secret counts
// at once on every instance. A secret that is not stored or cannot be decrypted is no secret: the answer is undefined and the webhook
// verifies nothing against anything else. The value leaves this module only inside the object the handler uses to verify.
import "server-only";
import type { Kysely } from "kysely";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { Database } from "../db/schema.ts";
import type { SecretStore } from "../secrets/store.ts";
import { readBillingSettings } from "./settings.ts";
import type { WebhookConfig } from "./webhook-handler.ts";

export async function readWebhookConfig(
  db: Kysely<Database>,
  secrets: Pick<SecretStore, "use">,
): Promise<WebhookConfig | undefined> {
  const stored =
    await createInstanceSettingsRepository(db).get("billing_settings");
  if (stored === undefined) return undefined;
  const secret = await secrets.use("paddle_webhook_secret");
  if (!secret.ok) return undefined;
  return {
    secret: secret.value.reveal(),
    environment: readBillingSettings(stored).environment,
  };
}
