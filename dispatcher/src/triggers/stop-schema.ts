// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** `DispatchStop` of contracts/dispatch-webhook.v1.json (#487): closed, so an unknown field is refused. */
export const DispatchStopSchema = z.strictObject({
  version: z.literal(1),
  type: z.literal("job.stop"),
  jobId: z.string().regex(UUID),
  stopId: z.string().regex(UUID),
  sentAt: z.string().regex(TIMESTAMP),
});
