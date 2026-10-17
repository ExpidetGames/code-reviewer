// SPDX-License-Identifier: Apache-2.0

// The fake Paddle API (fakes/paddle) for the tests of the billing module: started on a free loopback port and
// closed after the test, with a client of the app pointed at it. See fakes/README.md.
import {
  startPaddleFake,
  type FakePaddle,
  type PaddleFakeOptions,
} from "../../../fakes/paddle/server.ts";
import {
  createPaddleClient,
  type PaddleClient,
  type PaddleClientOptions,
} from "../billing/paddle-client.ts";
import { cleanUpAfterTest } from "./test-database.ts";

export async function startTestPaddle(
  options: PaddleFakeOptions = {},
): Promise<FakePaddle> {
  const fake = await startPaddleFake(options);
  cleanUpAfterTest(() => fake.close());
  return fake;
}

/** A client of the app against this fake: its key, its address, and no real waiting between tries. */
export function clientFor(
  fake: FakePaddle,
  overrides: Partial<PaddleClientOptions> = {},
): PaddleClient {
  return createPaddleClient({
    apiKey: fake.apiKey,
    baseUrl: fake.baseUrl,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}
