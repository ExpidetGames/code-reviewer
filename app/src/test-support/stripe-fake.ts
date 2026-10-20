// SPDX-License-Identifier: Apache-2.0

// The fake Stripe API (fakes/stripe) for the tests of the billing module: started on a free loopback port and closed after
// the test, with a client of the app pointed at it. See fakes/README.md.
import {
  startStripeFake,
  type StripeFake,
  type StripeFakeOptions,
} from "../../../fakes/stripe/server.ts";
import {
  createStripeClient,
  type StripeClient,
  type StripeClientOptions,
} from "../billing/stripe-client.ts";
import { cleanUpAfterTest } from "./test-database.ts";

export async function startTestStripe(
  options: StripeFakeOptions = {},
): Promise<StripeFake> {
  const fake = await startStripeFake(options);
  cleanUpAfterTest(() => fake.close());
  return fake;
}

/** A client of the app against this fake: its key, its address, and no real waiting between tries. */
export function clientFor(
  fake: StripeFake,
  overrides: Partial<StripeClientOptions> = {},
): StripeClient {
  return createStripeClient({
    apiKey: fake.apiKey,
    baseUrl: fake.baseUrl,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}
