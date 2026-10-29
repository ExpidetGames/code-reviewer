// SPDX-License-Identifier: LicenseRef-Proprietary

// #501: the Stripe client of the instance, made from the key the admin stored (#504) when a top-up needs it.
import { STRIPE_SECRET_NAMES } from "../secret-names/names.ts";
import { describe, expect, it } from "vitest";
import { createSecretStore } from "../secrets/store.ts";
import { startTestStripe } from "../test-support/stripe-fake.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { StripeClientError } from "./stripe-client.ts";
import {
  stripeEnvironmentFromSecrets,
  stripeClientFromSecrets,
  stripeWebhookSecretFromSecrets,
} from "./stripe-credentials.ts";

const APP_SECRET = "stripe-credentials-test-app-secret-0123456789-0123";

async function start() {
  const { db } = await createTestDatabase();
  const secrets = createSecretStore({
    db,
    names: STRIPE_SECRET_NAMES,
    appSecret: APP_SECRET,
  });
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

describe("the webhook secret and the environment of the instance", () => {
  // #502-T04
  it("reads the stored webhook secret, and null while there is none", async () => {
    const t = await start();
    const read = stripeWebhookSecretFromSecrets({ secrets: () => t.secrets });

    expect(await read()).toBeNull();

    await t.secrets.save("stripe_webhook_secret", "whsec_StoredValue00000", {
      updatedBy: null,
    });
    expect(await read()).toBe("whsec_StoredValue00000");
  });

  // #502-T09
  it("tells the environment from the prefix of the stored key, and null for no key or a key of no shape", async () => {
    const t = await start();
    const environment = stripeEnvironmentFromSecrets({
      secrets: () => t.secrets,
    });

    expect(await environment()).toBeNull();

    await t.secrets.save("stripe_api_key", "pk_test_not_a_secret_key_0000", {
      updatedBy: null,
    });
    expect(await environment()).toBeNull();

    await t.secrets.save("stripe_api_key", "sk_test_StoredValue0000000000", {
      updatedBy: null,
    });
    expect(await environment()).toBe("test");

    await t.secrets.save(
      "stripe_api_key",
      ["sk", "live", "StoredValue0000000000"].join("_"),
      { updatedBy: null },
    );
    expect(await environment()).toBe("live");
  });
});
