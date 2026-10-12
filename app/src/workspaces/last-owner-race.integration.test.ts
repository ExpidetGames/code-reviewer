// SPDX-License-Identifier: Apache-2.0

// Pins down the rule "the last Owner cannot leave" when two Owners leave at the same moment: two real
// processes, each with its own connection to one database file, start together (a lock held in the test's
// own process could not be released while a write waits for it, see TESTING.md). However they interleave,
// exactly one of the two leaves and the other is refused with `last_owner`; the workspace never ends up
// without an Owner. The same for two Owners who demote themselves.
import { describe, expect, it } from "vitest";
import { startDbProcess } from "../test-support/db-process.ts";
import { createWorkspaceHarness } from "../test-support/workspace-harness.ts";

type LeaveResult = { ok: boolean; error?: string };

async function race(round: number) {
  const h = await createWorkspaceHarness();
  const workspace = await h.addWorkspace(`duo-${String(round)}`);
  await h.addMember(workspace, "owner-a", "owner");
  await h.addMember(workspace, "owner-b", "owner");

  const first = startDbProcess([
    "leave-workspace",
    h.config.path,
    workspace.id,
    "owner-a",
  ]);
  const second = startDbProcess([
    "leave-workspace",
    h.config.path,
    workspace.id,
    "owner-b",
  ]);
  expect(await first.nextLine()).toBe("ready");
  expect(await second.nextLine()).toBe("ready");
  const startAt = Date.now() + 300;
  first.send(`go ${String(startAt)}`);
  second.send(`go ${String(startAt)}`);
  const a = JSON.parse(await first.nextLine()) as LeaveResult;
  const b = JSON.parse(await second.nextLine()) as LeaveResult;
  await first.exited;
  await second.exited;

  const owners = await h.db
    .selectFrom("workspace_members")
    .select("user_id")
    .where("workspace_id", "=", workspace.id)
    .where("role", "=", "owner")
    .execute();
  return { a, b, owners };
}

describe("two Owners leaving at the same time", () => {
  // #101-WM-10
  it("lets exactly one of them leave, and the workspace keeps an Owner", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { a, b, owners } = await race(round);

      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const refused = a.ok ? b : a;
      expect(refused).toMatchObject({ ok: false, error: "last_owner" });
      expect(owners).toHaveLength(1);
    }
  });
});
