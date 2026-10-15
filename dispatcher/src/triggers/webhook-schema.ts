// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** `DispatchWebhook` of contracts/dispatch-webhook.v1.json: closed, so an unknown field is refused. */
export const DispatchWebhookSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("job.ready"),
  jobId: z.string().regex(UUID),
  reviewKind: z.enum(["diff", "dynamic"]),
  attempt: z.number().int().min(1).max(100),
  dispatchId: z.string().regex(UUID),
  sentAt: z.string().regex(TIMESTAMP),
});
