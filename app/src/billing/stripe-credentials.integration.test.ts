// SPDX-License-Identifier: Apache-2.0

// #501: the Stripe client of the instance, made from the key the admin stored (#504) when a top-up needs it.
import { describe, expect, it } from "vitest";
import { createSecretStore } from "../secrets/store.ts";
import { startTestStripe } from "../test-support/stripe-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { StripeClientError } from "./stripe-client.ts";
import { stripeClientFromSecrets } from "./stripe-credentials.ts";

const APP_SECRET = "stripe-credentials-test-app-secret-0123456789-0123";

async function start() {
  const { db } = await createTestDatabase();
  const secrets = createSecretStore({ db, appSecret: APP_SECRET });
  const fake = await startTestStripe();
  return { db, secrets, fake };
}

describe("the Stripe client of the instance", () => {
  // #501-T07
  it("is made from the stored key and talks to the address it is given", async () => {
    const t = await start();
    await t.secrets.save("stripe_api_key", t.fake.apiKey, { updatedBy: null });
    const client = stripeClientFromSecrets({
      secrets: () => t.secrets,
      baseUrl: t.fake.baseUrl,
    });

    const account = await (await client()).getAccount();

    expect(account.id).toBeTruthy();
    expect(t.fake.requests().map((r) => r.authenticated)).toEqual([true]);
  });

  // #501-T07
  it("rejects while no key is stored, and for a value that is no secret key", async () => {
    const t = await start();
    const client = stripeClientFromSecrets({
      secrets: () => t.secrets,
      baseUrl: t.fake.baseUrl,
    });

    await expect(client()).rejects.toThrow();

    await t.secrets.save("stripe_api_key", "pk_test_not_a_secret_key_0000", {
      updatedBy: null,
    });
    await expect(client()).rejects.toBeInstanceOf(StripeClientError);
  });

  // #501-T09
  it("says nothing of the key when it rejects", async () => {
    const t = await start();
    await t.secrets.save("stripe_api_key", "pk_test_not_a_secret_key_0000", {
      updatedBy: null,
    });
    const client = stripeClientFromSecrets({
      secrets: () => t.secrets,
      baseUrl: t.fake.baseUrl,
    });

    const error = await client().catch((caught: unknown) => caught);

    expect(String(error)).not.toContain("not_a_secret_key");
  });
});
