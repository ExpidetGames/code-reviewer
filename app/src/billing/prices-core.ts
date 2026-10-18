// SPDX-License-Identifier: Apache-2.0

// What the parts of the prices service share (#440): the database, the clock, the configured Paddle environment, a client of
// Paddle for the stored key, and the one reading of what a Paddle failure means for the admin. `prices-service.ts` builds it;
// `prices-create.ts` and `prices-archive.ts` use it. Nothing here reads a request.
import "server-only";
import type { PaddleEnv } from "../db/repositories/billing-plan-prices-repository.ts";
import type { PaddleClient } from "./paddle-client.ts";
import type { LinkContext } from "./price-link.ts";
import type { PriceRefusal } from "./price-errors.ts";

export type MadeClient =
  { ok: true; client: PaddleClient } | { ok: false; refusal: PriceRefusal };

export type PricesCore = LinkContext & {
  /** The environment billing is set to. */
  configuredEnvironment(): Promise<PaddleEnv>;
  /** A client for the stored key; the key does not leave the client. */
  storedClient(env: PaddleEnv): Promise<MadeClient>;
  /** What Paddle's refusal or silence means for the admin. Only the code of the error is read, never its text. */
  paddleRefusal(error: unknown): PriceRefusal;
};
