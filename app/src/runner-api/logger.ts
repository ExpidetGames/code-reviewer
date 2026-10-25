// SPDX-License-Identifier: LicenseRef-Proprietary

// The two log levels the runner API uses; the default writes to the console and tests pass their
// own. A line names the job, the runner and the outcome, and nothing else: never a token, a lease
// token, a request body, a result or the text of an error that is not marked as safe.
import { hasSafeMessage } from "../integrations/errors.ts";

export type RunnerApiLogger = {
  info(line: string): void;
  error(line: string): void;
};

export const consoleRunnerApiLogger: RunnerApiLogger = {
  info: (line) => console.info(line),
  error: (line) => console.error(line),
};

/** An error as a log line may show it: its safe message, or only its name. */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown error";
  return hasSafeMessage(error) ? `${name}: ${error.message}` : name;
}
