// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down when a test that needs the operating system to deny a file operation is skipped: as
// root outside CI it is skipped with a visible reason, for a non-root user it runs, and in CI it
// fails instead of being skipped, so a CI runner that runs as root cannot drop the check silently.
import { describe, expect, it, vi } from "vitest";
import {
  NEEDS_NON_ROOT_REASON,
  needsNonRootTest,
  type SkipContext,
} from "./root-only.ts";

function fakeContext() {
  const skipped: string[] = [];
  const context: SkipContext = {
    skip: (reason) => {
      skipped.push(reason);
      // Vitest's skip aborts the test body by throwing; mirror that so the test can tell it apart.
      throw new Error("skipped");
    },
  };
  return { context, skipped };
}

describe("itNeedsNonRoot", () => {
  // #186-T01
  it("skips a test with the reason when the process runs as root outside CI", () => {
    const { context, skipped } = fakeContext();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let ran = false;
    const test = needsNonRootTest(
      { uid: 0, ci: false },
      "a root-only test",
      () => {
        ran = true;
      },
    );

    expect(() => test(context)).toThrow("skipped");
    expect(skipped).toEqual([NEEDS_NON_ROOT_REASON]);
    expect(ran).toBe(false);
    expect(stderr).toHaveBeenCalledWith(
      `skipped "a root-only test": ${NEEDS_NON_ROOT_REASON}\n`,
    );
  });

  // #186-T02
  it("runs the test body when the process does not run as root", () => {
    const { context, skipped } = fakeContext();
    let ran = false;
    const test = needsNonRootTest(
      { uid: 1000, ci: false },
      "a root-only test",
      () => {
        ran = true;
      },
    );

    test(context);

    expect(ran).toBe(true);
    expect(skipped).toEqual([]);
  });

  // #186-T03
  it("fails instead of skipping when the process runs as root in CI", () => {
    expect(() =>
      needsNonRootTest({ uid: 0, ci: true }, "a root-only test", () => {}),
    ).toThrow(/non-root user/);
  });
});
