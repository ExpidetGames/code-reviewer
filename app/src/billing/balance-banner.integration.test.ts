// SPDX-License-Identifier: LicenseRef-Proprietary

// #506: who sees the banner and when. Only an Owner or an Admin, only while billing is on and the balance of THEIR workspace is
// low, zero or below zero; a Member and billing off see nothing, and nothing of billing is read for them.
import { describe, expect, it } from "vitest";
import { BILLING_ENGINES } from "../test-support/billing-engines.ts";
import {
  fundWorkspace,
  setBillingSwitch,
} from "../test-support/billing-switch.ts";
import { loadBalanceBanner } from "./balance-banner.ts";

const USD = 1_000_000;

for (const engine of BILLING_ENGINES) {
  describe.skipIf(engine.skip)(`the balance banner on ${engine.name}`, () => {
    async function start(options: { billing?: boolean } = {}) {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      if (options.billing !== false) await setBillingSwitch(db, true);
      const load = (
        role: "owner" | "admin" | "member",
        workspace = workspaceId,
      ) =>
        loadBalanceBanner({
          db,
          workspace: { id: workspace, slug: "acme" },
          role,
        });
      return { db, workspaceId, otherWorkspaceId, load };
    }

    // #506-T10
    it("shows to an Owner and an Admin, not to a Member, while the balance is low", async () => {
      const t = await start();
      await fundWorkspace(t.db, t.workspaceId, 3 * USD);

      const expected = {
        level: "low",
        balanceMicroUsd: 3 * USD,
        billingHref: "/w/acme/settings/billing",
      };
      expect(await t.load("owner")).toEqual(expected);
      expect(await t.load("admin")).toEqual(expected);
      expect(await t.load("member")).toBeNull();
    });

    // #506-T04
    it("shows the empty state at zero and the negative state below zero", async () => {
      const t = await start();
      expect(await t.load("owner")).toMatchObject({
        level: "empty",
        balanceMicroUsd: 0,
      });

      await fundWorkspace(t.db, t.workspaceId, 1 * USD);
      await t.db
        .updateTable("billing_balances")
        .set({ balance_micro_usd: -250_000 })
        .execute();

      expect(await t.load("owner")).toMatchObject({
        level: "negative",
        balanceMicroUsd: -250_000,
      });
    });

    // #506-T10
    it("shows nothing while the balance is at the threshold or above", async () => {
      const t = await start();
      await fundWorkspace(t.db, t.workspaceId, 5 * USD);

      expect(await t.load("owner")).toBeNull();
    });

    // #506-T09
    it("shows the balance of the workspace asked for, not of another", async () => {
      const t = await start();
      await fundWorkspace(t.db, t.workspaceId, 100 * USD);
      await fundWorkspace(t.db, t.otherWorkspaceId, 2 * USD);

      expect(await t.load("owner")).toBeNull();
      expect(await t.load("owner", t.otherWorkspaceId)).toMatchObject({
        balanceMicroUsd: 2 * USD,
      });
    });

    // #506-T08
    it("shows nothing while billing is off", async () => {
      const t = await start({ billing: false });

      expect(await t.load("owner")).toBeNull();
    });

    // #506-T08
    it("reads no billing table for a Member", async () => {
      const t = await start();
      const reads: string[] = [];
      const spied = t.db.withPlugin({
        transformQuery({ node }) {
          reads.push(JSON.stringify(node));
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      });

      expect(
        await loadBalanceBanner({
          db: spied,
          workspace: { id: t.workspaceId, slug: "acme" },
          role: "member",
        }),
      ).toBeNull();
      expect(reads).toEqual([]);
    });

    // #506-T07
    it("carries the balance and the link and nothing else", async () => {
      const t = await start();
      await fundWorkspace(t.db, t.workspaceId, 1 * USD);

      const banner = await t.load("owner");

      expect(Object.keys(banner ?? {}).sort()).toEqual([
        "balanceMicroUsd",
        "billingHref",
        "level",
      ]);
    });
  });
}
