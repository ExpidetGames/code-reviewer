// SPDX-License-Identifier: Apache-2.0

// #505: the key mode the billing page names, read from the summary of the workspace's LLM access.
import { describe, expect, it } from "vitest";
import { workspaceKeyModeOf } from "./workspace-key-mode.ts";

describe("the key mode the billing page names", () => {
  // #505-T01
  it.each([
    [{ configured: true, source: "operator" }, "managed"],
    [{ configured: true, source: "workspace" }, "own"],
    [{ configured: false, reason: "operator_key_missing" }, "managed"],
    [{ configured: false, reason: "operator_key_unreadable" }, "managed"],
    [{ configured: false, reason: "no_key" }, "own"],
    [{ configured: false, reason: "key_unreadable" }, "own"],
    [{ configured: false, reason: "key_binding_mismatch" }, "own"],
    [{ configured: false, reason: "entitlements_invalid" }, "none"],
  ] as const)("reads %j as %s", (summary, mode) => {
    expect(workspaceKeyModeOf(summary)).toBe(mode);
  });
});
