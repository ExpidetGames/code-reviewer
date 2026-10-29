// SPDX-License-Identifier: LicenseRef-Proprietary

// A deployment without the `billing` capability (#731: the clone runs `review` and `dynamic-review`) is a complete product with
// billing off, not a billing that is switched off: whatever a stored setting says, no balance is read, no credit is checked, no
// job waits for money and no start credit is granted. Proven on the real chain of the runner API (enqueue, claim, report) over a
// real database, against the same chain on code-review.com, which refuses the same job for an empty balance.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { sha } from "../test-support/jobs.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../test-support/runner-api-harness.ts";
import { isBillingOn, readBillingSwitch } from "./enabled.ts";
import { readClaimBilling } from "./claim-billing.ts";
import { ensureStartCredit } from "./start-credit.ts";

const FACTORY_CAPABILITIES = "review,dynamic-review";
const harnesses: RunnerApiHarness[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A workspace with an active project, the billing switch set to ON in the database, and an empty balance. */
async function startWithBillingSwitchedOn(): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({
    projects: true,
    refusalNotices: {},
  });
  harnesses.push(h);
  h.fake.addPullRequest(h.repository.fullName, {
    number: 20,
    title: "Change 20",
    headRef: "feature/change-20",
    baseRef: "main",
    author: { login: "alice", id: 1001 },
    state: "open",
    headSha: sha("a"),
  });
  await h.projectService.activateProject(h.repositoryId);
  await setBillingSwitch(h.db, true);
  return h;
}

const push = (h: RunnerApiHarness) => ({
  prNumber: 20,
  prUrl: `https://github.test/${h.repository.fullName}/pull/20`,
  headSha: sha("a"),
});

describe("a deployment without the billing capability", () => {
  // #731-T01
  it("control: code-review.com with the same stored setting and an empty balance refuses the claim for the balance", async () => {
    const h = await startWithBillingSwitchedOn();
    expect(await isBillingOn(h.db)).toBe(true);
    const job = await h.enqueueNew(push(h));

    expect((await h.claim()).status).toBe(204);

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "failed",
      errorCode: "insufficient_balance",
    });
  });

  // #731-T03
  it("reads the billing switch as off, whatever the stored setting says, and prices nothing", async () => {
    vi.stubEnv("PRODUCT_CAPABILITIES", FACTORY_CAPABILITIES);
    const h = await startWithBillingSwitchedOn();

    expect(await isBillingOn(h.db)).toBe(false);
    expect(await readBillingSwitch(h.db)).toMatchObject({
      enabled: false,
      missing: [],
      rates: null,
    });
    expect(await readClaimBilling(h.db)).toEqual({ state: "off" });
    expect(await ensureStartCredit(h.db, h.workspaceId)).toEqual({
      status: "billing_off",
    });
  });

  // #731-T03
  it("runs a review from the push to the result with no balance: claimed, reported, nothing in the journal", async () => {
    vi.stubEnv("PRODUCT_CAPABILITIES", FACTORY_CAPABILITIES);
    const h = await startWithBillingSwitchedOn();
    const job = await h.enqueueNew(push(h));

    const response = await h.claim();
    expect(response.status).toBe(200);
    const claimed = (await response.json()) as {
      job: { id: string; leaseToken: string };
    };
    expect(claimed.job.id).toBe(job.id);
    h.clock.advance(90_000);
    expect(
      (await h.complete(job.id, claimed.job.leaseToken, goodResult())).status,
    ).toBe(200);

    expect(await h.queue.get(job.id)).toMatchObject({ status: "succeeded" });
    const journal = createBillingJournalRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    );
    expect((await journal.entries({ limit: 10 })).entries).toEqual([]);
    expect((await journal.balance()).balanceMicroUsd).toBe(0);
  });

  // #731-T03
  it("never refuses a claim for the balance or for incomplete rates, with the switch on and no rate at all", async () => {
    vi.stubEnv("PRODUCT_CAPABILITIES", FACTORY_CAPABILITIES);
    const h = await startWithBillingSwitchedOn();
    await setBillingSwitch(h.db, true, {});
    const job = await h.enqueueNew(push(h));

    expect((await h.claim()).status).toBe(200);

    expect(await h.queue.get(job.id)).toMatchObject({ status: "running" });
  });
});
