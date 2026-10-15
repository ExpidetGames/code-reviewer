// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  AF_VSOCK,
  SeccompProfileError,
  denySocketFamilies,
} from "./seccomp.ts";

// A cut-down default profile: the shape of Docker's, with `socket` in the big allow list.
function defaultProfile() {
  return {
    defaultAction: "SCMP_ACT_ERRNO",
    defaultErrnoRet: 1,
    architectures: ["SCMP_ARCH_X86_64"],
    syscalls: [
      {
        names: ["read", "write", "socket", "socketpair"],
        action: "SCMP_ACT_ALLOW",
      },
      {
        names: ["personality"],
        action: "SCMP_ACT_ALLOW",
        args: [{ index: 0, value: 0, op: "SCMP_CMP_EQ" }],
      },
    ],
  };
}

describe("a seccomp profile derived from the default one", () => {
  // #325-T06
  it("lets socket through for every family but the denied one", () => {
    const derived = denySocketFamilies(defaultProfile(), [AF_VSOCK]);
    const syscalls = derived.syscalls as Array<{
      names: string[];
      action: string;
      args?: unknown[];
    }>;

    expect(syscalls.find((s) => s.names.includes("socketpair"))?.names).toEqual(
      ["read", "write", "socketpair"],
    );
    expect(syscalls.at(-1)).toEqual({
      names: ["socket"],
      action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: 40, op: "SCMP_CMP_NE" }],
    });
    // Nothing else about the default profile changes.
    expect(derived.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(derived.architectures).toEqual(["SCMP_ARCH_X86_64"]);
  });

  // #325-T06
  it("denies several families with one rule", () => {
    const derived = denySocketFamilies(defaultProfile(), [AF_VSOCK, 16]);
    const rule = (derived.syscalls as Array<{ args?: unknown[] }>).at(-1);

    expect(rule?.args).toEqual([
      { index: 0, value: 40, op: "SCMP_CMP_NE" },
      { index: 0, value: 16, op: "SCMP_CMP_NE" },
    ]);
  });

  // #325-T06
  it("does not change the profile it is given", () => {
    const before = defaultProfile();
    denySocketFamilies(before, [AF_VSOCK]);

    expect(before).toEqual(defaultProfile());
  });

  // #325-T06
  it("fails closed on a profile it does not understand", () => {
    for (const bad of [
      null,
      {},
      { syscalls: [] },
      { syscalls: [{ names: ["read"], action: "SCMP_ACT_ALLOW" }] },
    ])
      expect(() => denySocketFamilies(bad, [AF_VSOCK])).toThrow(
        SeccompProfileError,
      );
    expect(() => denySocketFamilies(defaultProfile(), [])).toThrow(
      SeccompProfileError,
    );
    expect(() => denySocketFamilies(defaultProfile(), [-1])).toThrow(
      SeccompProfileError,
    );
  });

  // #325-T06
  it.each(["SCMP_ACT_ALLOW", "SCMP_ACT_LOG", "SCMP_ACT_TRACE", undefined])(
    "refuses a profile whose default action is %s: it would let the denied family through",
    (defaultAction) => {
      const profile: Record<string, unknown> = defaultProfile();
      if (defaultAction === undefined) delete profile.defaultAction;
      else profile.defaultAction = defaultAction;

      expect(() => denySocketFamilies(profile, [AF_VSOCK])).toThrow(
        SeccompProfileError,
      );
    },
  );

  // #325-T06
  it.each([
    "SCMP_ACT_ERRNO",
    "SCMP_ACT_KILL",
    "SCMP_ACT_KILL_PROCESS",
    "SCMP_ACT_TRAP",
  ])("accepts a profile whose default action is %s", (defaultAction) => {
    expect(() =>
      denySocketFamilies({ ...defaultProfile(), defaultAction }, [AF_VSOCK]),
    ).not.toThrow();
  });
});
