// SPDX-License-Identifier: Apache-2.0

// What the balance journal of the app under test says about itself (the journal invariant of the billing journeys, #508-T10): its own
// `verify()` on the app's database file, through src/test-support/e2e-billing-journal-child.ts. It only reads.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const CHILD = resolve(
  process.cwd(),
  "src/test-support/e2e-billing-journal-child.ts",
);

export type JournalVerdict = {
  workspaceId: string;
  verification: {
    balanceMicroUsd: number;
    expectedBalanceMicroUsd: number;
    differenceMicroUsd: number;
    reservedMicroUsd: number;
    reservedDifferenceMicroUsd: number;
    strandedHoldCount: number;
    consistent: boolean;
  };
  /** How many entries of each type the default workspace's journal holds. */
  entries: Record<string, number>;
};

export async function verifyJournal(
  databasePath: string,
): Promise<JournalVerdict> {
  const { stdout } = await run(
    process.execPath,
    [
      "--no-warnings",
      "--conditions=react-server",
      CHILD,
      "verify",
      resolve(process.cwd(), databasePath),
    ],
    { cwd: process.cwd() },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as JournalVerdict;
}
