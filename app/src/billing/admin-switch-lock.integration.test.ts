// SPDX-License-Identifier: LicenseRef-Proprietary

// Switching billing on is judged under the lock of the billing settings, and the credentials it judges are read there too (#504):
// a request that removes the webhook secret at the moment another switches billing on must not leave billing on without the
// secret. The interleaving is made by holding the switch-on at its read of the webhook secret.
import { describe, expect, it } from "vitest";
import { startStripeFake } from "../../../fakes/stripe/server.ts";
import { insertUser } from "../test-support/users.ts";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import { SETUP_TEST_SECRET } from "../test-support/setup-harness.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import { createSecretStore, type SecretStore } from "../secrets/store.ts";
import { createBillingAdminService } from "./admin-service.ts";
import { createStripeClient } from "./stripe-client.ts";

const RATES = {
  factorA: 50_000,
  minuteRateMicroUsd: { diff: 13_000, dynamic: 16_000 },
  diffAiReserveMicroUsd: 150_000,
};
const WEBHOOK_SECRET = "whsec_ManualSecret0123456789abcdef";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(BILLING_ENGINES)(
  "the switch and the webhook secret on $name",
  (engine) => {
    const it_ = engine.skip ? it.skip : it;

    // #504-T19
    it_(
      "never leaves billing on without the webhook secret when it is removed while billing is being switched on",
      async () => {
        const { db } = await engine.create();
        const adminId = await insertUser(db, { id: "admin-lock" });
        const stripe = await startStripeFake();
        cleanUpAfterTest(() => stripe.close());
        const secrets = createSecretStore({ db, appSecret: SETUP_TEST_SECRET });

        // The first look at the webhook secret after `arm()` answers, then waits for `release()`.
        let armed = false;
        let reached: () => void = () => undefined;
        let release: () => void = () => undefined;
        const atTheGate = new Promise<void>((resolve) => (reached = resolve));
        const opened = new Promise<void>((resolve) => (release = resolve));
        const holding = (store: SecretStore): SecretStore => ({
          ...store,
          async status(name) {
            const status = await store.status(name);
            if (armed && name === "stripe_webhook_secret") {
              armed = false;
              reached();
              await opened;
            }
            return status;
          },
        });
        const service = createBillingAdminService({
          db,
          secretsOn: (executor) =>
            holding(
              createSecretStore({ db: executor, appSecret: SETUP_TEST_SECRET }),
            ),
          publicUrl: "https://reviews.example.test",
          clientFor: (apiKey, environment) =>
            createStripeClient({
              apiKey,
              baseUrl: stripe.baseUrl,
              environment,
              maxRetries: 0,
              sleep: () => Promise.resolve(),
            }),
          log: () => undefined,
        });
        await service.chooseAdapter(adminId, "stripe");
        await service.saveRates(adminId, RATES);
        await service.saveCredentials(adminId, {
          apiKey: stripe.apiKey,
          webhookSecret: WEBHOOK_SECRET,
        });
        expect((await service.checkConnection(adminId)).ok).toBe(true);

        armed = true;
        const switching = service.setEnabled(adminId, true);
        await atTheGate;
        const removing = service.removeSecret(adminId, "webhookSecret");
        // If nothing stops the removal, it is done in this time.
        await Promise.race([removing, pause(300)]);
        release();
        const [switched, removed] = await Promise.all([switching, removing]);

        const stored = await secrets.status("stripe_webhook_secret");
        // The switch as the admin set it (`isBillingOn` would hide the fault: it says off whenever the secret is gone).
        const { enabled } = await service.view();
        expect(!enabled || stored.state === "configured").toBe(true);
        // One of the two went first and the other found its result.
        expect([switched.ok, removed.ok].filter(Boolean)).toHaveLength(1);
      },
    );
  },
);
