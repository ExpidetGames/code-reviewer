// SPDX-License-Identifier: Apache-2.0

// What the handlers of the single events share (#441): the transaction they run in, the environment, the clock, the log, and the
// event as it was verified and parsed. Server code only.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { PaddleEnv } from "../db/repositories/billing-plan-prices-repository.ts";

/** Where the handler writes: ids and codes only, never a payload, a secret or anything a customer entered. */
export type WebhookLogger = {
  info(message: string): void;
  error(message: string): void;
};

export type ApplyContext = {
  /** The transaction the event is applied in. */
  db: Kysely<Database>;
  env: PaddleEnv;
  now: () => Date;
  logger: WebhookLogger;
  eventId: string;
  eventType: string;
  /** Canonical UTC text of the event's `occurred_at`: the stamp events are ordered by. */
  occurredAt: string;
  /** Untrusted until a schema has read it. */
  data: unknown;
};
