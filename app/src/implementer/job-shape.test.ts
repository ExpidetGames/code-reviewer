// SPDX-License-Identifier: LicenseRef-Proprietary

// The one place that writes the pull request columns of a turn's job (#752).
import { describe, expect, it } from "vitest";
import { implementerJobShape } from "./job-shape.ts";

const input = {
  workspaceId: "w-1",
  repositoryUrl: "https://github.test/acme/widgets/",
  branch: "implementer/abc123",
  slot: 3,
  baseSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
  clientRequestId: "req-1",
};

describe("the shape of a turn's job", () => {
  // #752-T01
  it("is a negative number that is never a pull request, a branch url and the documented constants", () => {
    expect(implementerJobShape(input)).toEqual({
      prNumber: -3,
      prUrl: "https://github.test/acme/widgets/tree/implementer/abc123",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      command: "review",
      args: "",
      deliveryId: "implementer:w-1:req-1",
    });
  });

  // #752-T01
  it.each([0, -1, 1.5, Number.NaN])("refuses the slot %s", (slot) => {
    expect(() => implementerJobShape({ ...input, slot })).toThrow();
  });

  // #752-T01
  it("keeps the deliveries of two workspaces apart for one request id", () => {
    expect(
      implementerJobShape({ ...input, workspaceId: "w-2" }).deliveryId,
    ).not.toBe(implementerJobShape(input).deliveryId);
  });
});
