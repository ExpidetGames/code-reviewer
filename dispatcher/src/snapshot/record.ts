// SPDX-License-Identifier: LicenseRef-Proprietary

// The record a successful run leaves: what the Dispatcher is configured with (#330). Nothing in it is secret.
import { z } from "zod";

export const GoldenRecordSchema = z.strictObject({
  version: z.literal(1),
  /** The snapshot the Sandbox-Launcher (#329) creates job VMs from. */
  snapshotId: z.string().min(3).max(128),
  /** The id of the Worker image inside the snapshot: the Launcher compares it with `docker image inspect`. */
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  builtAt: z.iso.datetime(),
  region: z.literal("fra1"),
  target: z.string(),
  commit: z.string().optional(),
});
export type GoldenRecord = z.infer<typeof GoldenRecordSchema>;
