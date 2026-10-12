// SPDX-License-Identifier: Apache-2.0

// #186: Registers a test that only proves anything while the operating system denies a file
// operation because of directory permissions. A process running as root bypasses those checks, so
// `itNeedsNonRoot` skips such a test with a visible reason when the suite runs as root outside CI,
// and refuses to skip when CI is set, so a CI runner that runs as root fails instead of dropping
// the check silently.
import { it } from "vitest";

export const NEEDS_NON_ROOT_REASON =
  "needs a non-root user, enforced in CI" as const;

/** The part of a test context the helper uses; the test body may use the rest of it as well. */
export type SkipContext = {
  /** Marks the test as skipped with the given reason, like Vitest's test context does. */
  skip: (reason: string) => void;
};

export type RootOnlyEnvironment = {
  /** The effective user id, or undefined on a platform that has no `getuid`. */
  uid: number | undefined;
  /** Whether the process runs in CI. */
  ci: boolean;
};

/** Reads the environment the running process gives: the user id and whether CI is set. */
export function currentRootOnlyEnvironment(): RootOnlyEnvironment {
  return { uid: process.getuid?.(), ci: Boolean(process.env.CI) };
}

/**
 * The reason to report the test as skipped, or null when it can run. Throws when the process runs
 * as root in CI, because the permission checks may never be dropped there.
 */
export function nonRootSkipReason(
  environment: RootOnlyEnvironment,
): string | null {
  if (environment.uid !== 0) return null;
  if (environment.ci) {
    throw new Error(
      `${NEEDS_NON_ROOT_REASON}, but the process runs as root with CI set: refusing to skip the permission check. Run the suite as a non-root user.`,
    );
  }
  return NEEDS_NON_ROOT_REASON;
}

/** The test function to register for an environment: the body itself, or one that skips. */
export function needsNonRootTest(
  environment: RootOnlyEnvironment,
  body: () => void | Promise<void>,
): (context: SkipContext) => void | Promise<void> {
  const reason = nonRootSkipReason(environment);
  if (reason === null) return body;
  return (context) => context.skip(reason);
}

/** Registers a test that only holds for a non-root user; see the file comment. */
export function itNeedsNonRoot(
  name: string,
  body: () => void | Promise<void>,
): void {
  it(name, needsNonRootTest(currentRootOnlyEnvironment(), body));
}
