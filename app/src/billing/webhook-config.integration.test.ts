// SPDX-License-Identifier: Apache-2.0

// The webhook accepts only the configured notification secret (#441, ADR 0005, 2.10 and 2.12): the one stored encrypted by the admin
// portal (#437), read for each request, together with the environment of the billing settings. A secret that cannot be read (nothing
// stored, or stored under another `APP_SECRET`) is no secret: the webhook answers 503 rather than verify against something else.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createSecretStore } from "../secrets/store.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import {
  TEST_BILLING_SETTINGS,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import {
  WEBHOOK_SECRET,
  WEBHOOK_URL,
  event,
  subscriptionData,
} from "../test-support/billing-webhook-harness.ts";
import { buildDeliveries } from "../../../fakes/paddle/webhooks.ts";
import { createBillingWebhookHandler } from "./webhook-handler.ts";
import { readWebhookConfig } from "./webhook-config.ts";

const APP_SECRET = "a-test-app-secret-of-sufficient-length-0123456789";

async function setup(environment: "sandbox" | "live" = "sandbox") {
  const { db } = await createTestDatabase();
  await createInstanceSettingsRepository(db).set(
    "billing_settings",
    { ...TEST_BILLING_SETTINGS, environment, enabled: true },
    null,
  );
  const secrets = createSecretStore({ db, appSecret: APP_SECRET });
  return { db, secrets };
}

describe("the configuration of the webhook", () => {
  // #441-T02
  it("is the stored webhook secret and the environment of the billing settings", async () => {
    const { db, secrets } = await setup("live");
    await secrets.save("paddle_webhook_secret", WEBHOOK_SECRET, {
      updatedBy: null,
    });

    const config = await readWebhookConfig(db, secrets);

    expect(config).toEqual({ secret: WEBHOOK_SECRET, environment: "live" });
  });

  // #441-T02
  it("is nothing when no secret is stored, or the stored one cannot be decrypted", async () => {
    const { db, secrets } = await setup();
    expect(await readWebhookConfig(db, secrets)).toBeUndefined();

    await secrets.save("paddle_webhook_secret", WEBHOOK_SECRET, {
      updatedBy: null,
    });
    const otherKey = createSecretStore({
      db,
      appSecret: "another-app-secret-of-sufficient-length-9876543210",
    });
    expect(await readWebhookConfig(db, otherKey)).toBeUndefined();
  });

  // #441-T02
  it("is nothing before billing was ever configured", async () => {
    const { db } = await createTestDatabase();
    const secrets = createSecretStore({ db, appSecret: APP_SECRET });
    await secrets.save("paddle_webhook_secret", WEBHOOK_SECRET, {
      updatedBy: null,
    });

    expect(await readWebhookConfig(db, secrets)).toBeUndefined();
  });

  // #441-T02
  it("makes the handler accept the stored secret and no other, and follow a changed secret at once", async () => {
    const { db, secrets } = await setup();
    await setBillingSwitch(db, true);
    await secrets.save("paddle_webhook_secret", WEBHOOK_SECRET, {
      updatedBy: null,
    });
    const handler = createBillingWebhookHandler({
      db,
      config: () => readWebhookConfig(db, secrets),
    });
    const send = async (secret: string) => {
      const [delivery] = buildDeliveries(
        [event("customer.updated", subscriptionData())],
        { secret },
      );
      return handler(
        new Request(WEBHOOK_URL, {
          method: "POST",
          headers: delivery?.headers ?? {},
          body: delivery?.body ?? "",
        }),
      );
    };

    const stored = await send(WEBHOOK_SECRET);
    const other = await send("pdl_ntfset_somebody_else");
    await secrets.save("paddle_webhook_secret", "pdl_ntfset_rotated", {
      updatedBy: null,
    });
    const oldAfterRotation = await send(WEBHOOK_SECRET);
    const rotated = await send("pdl_ntfset_rotated");

    expect([stored.status, other.status]).toEqual([200, 401]);
    expect([oldAfterRotation.status, rotated.status]).toEqual([401, 200]);
  });
});
