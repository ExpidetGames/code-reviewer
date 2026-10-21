// SPDX-License-Identifier: Apache-2.0

// Leaves two billing review rows in the app under test the way the webhook does, through the app's real repositories on its
// database file (src/test-support/e2e-billing-reviews-child.ts). The journeys never write rows themselves.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHILD = resolve(
  process.cwd(),
  "src/test-support/e2e-billing-reviews-child.ts",
);

/** A refused payment of the default workspace's 25 USD top-up, and a refund of a payment that is none of ours. */
export async function seedBillingReviews(
  databasePath: string,
): Promise<{ workspaceId: string }> {
  const { stdout } = await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      CHILD,
      "seed",
      resolve(process.cwd(), databasePath),
    ],
    { cwd: process.cwd() },
  );
  const line = stdout.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(line) as { workspaceId: string };
}
