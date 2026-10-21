// SPDX-License-Identifier: Apache-2.0

// The billing journeys of #508 that are proven below the browser: each one runs the real chain of parts over a real database through the
// runner API as a runner calls it (claim, report), with the notice of a refusal posted to the fake GitHub, and ends with the journal invariant
// (`verify()` finds no difference, no hold is stranded). The browser journeys (src/../e2e/billing-journeys) prove the pages; the settlement
// matrix is in settle-jobs.integration.test.ts. Made-up rates (test-support/billing-switch.ts): A = 5.0, B(Diff) = 13,000 and B(Dynamic)
// = 16,000 micro-USD a started minute. The runner here has no VM, so a run is measured by its time on the runner: 90 seconds are 2 minutes.
import { afterEach, describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingWorkspaceSettingsRepository } from "../db/repositories/billing-workspace-settings-repository.ts";
import { createLlmKeyModeStore } from "../llm/key-mode-store.ts";
import { DEFAULT_LLM_PROVIDER } from "../llm/providers/index.ts";
import {
  fundWorkspace,
  setBillingSwitch,
  TEST_BILLING_RATES,
} from "../test-support/billing-switch.ts";
import { sha } from "../test-support/jobs.ts";
import {
  goodResult,
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../test-support/runner-api-harness.ts";
import type { KeyMode } from "../workspaces/entitlements.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const OPERATOR_KEY = "plain-operator-key-0001-aaaaaaaa";
const FUNDING = 10_000_000;
const SUPERSEDING_CLAIM = { engines: ["pr-agent"], features: ["supersede"] };

// What a run reports: the cost the provider stated, on top of a result that says it succeeded.
const withCost = (costUsd: number | null) =>
  goodResult({
    usage: { ...goodResult().usage!, costUsd },
  });

const harnesses: RunnerApiHarness[] = [];

async function start(
  options: {
    keyMode?: KeyMode;
    ownKey?: boolean;
    funding?: number;
    hourlyReviewLimit?: number;
  } = {},
): Promise<RunnerApiHarness> {
  const h = await startRunnerApiHarness({
    projects: true,
    refusalNotices: {},
    llmKey: options.ownKey === false ? null : undefined,
  });
  harnesses.push(h);
  // The fixture's repository has two open pull requests; every journey review gets one of its own.
  for (let number = 20; number < 40; number += 1)
    h.fake.addPullRequest(h.repository.fullName, {
      number,
      title: `Change ${String(number)}`,
      headRef: `feature/change-${String(number)}`,
      baseRef: "main",
      author: { login: "alice", id: 1001 },
      state: "open",
      headSha: sha("a"),
    });
  await h.projectService.activateProject(h.repositoryId);
  const saved = await h.llm
    .operatorKey()
    .save({ provider: DEFAULT_LLM_PROVIDER, apiKey: OPERATOR_KEY }, null);
  expect(saved.ok).toBe(true);
  await createLlmKeyModeStore(h.db, h.workspaceId, h.clock.now).set(
    options.keyMode ?? "managed",
    null,
  );
  await setBillingSwitch(h.db, true, {
    ...TEST_BILLING_RATES,
    ...(options.hourlyReviewLimit === undefined
      ? {}
      : { hourlyReviewLimit: options.hourlyReviewLimit }),
  });
  if (options.funding !== 0)
    await fundWorkspace(
      h.db,
      h.workspaceId,
      options.funding ?? FUNDING,
      h.clock.now,
    );
  return h;
}

const journalOf = (h: RunnerApiHarness) =>
  createBillingJournalRepository(h.db, h.workspaceId, h.clock.now);

const balanceOf = async (h: RunnerApiHarness) =>
  (await journalOf(h).balance()).balanceMicroUsd;

/** The entries a job's settlement wrote: its type and the two parts of the price. */
async function usageOf(h: RunnerApiHarness, jobId: string) {
  const { entries } = await journalOf(h).entries({ limit: 100 });
  return entries
    .filter((entry) => entry.jobId === jobId)
    .map((entry) => ({
      type: entry.type,
      amount: entry.amountMicroUsd,
      ai: entry.aiMicroUsd,
      infra: entry.infraMicroUsd,
    }));
}

/** The push of a pull request: its number and address (the claim looks the pull request up by them) and a head. */
function pushOf(h: RunnerApiHarness, prNumber: number, head = "a") {
  return {
    prNumber,
    prUrl: `https://github.test/${h.repository.fullName}/pull/${String(prNumber)}`,
    headSha: sha(head),
  };
}

/** A push: a new job on its own pull request, claimed by the runner, `seconds` later reported with `result`. */
async function runReview(
  h: RunnerApiHarness,
  prNumber: number,
  result: Parameters<RunnerApiHarness["complete"]>[2],
  seconds = 90,
) {
  const job = await h.enqueueNew(pushOf(h, prNumber));
  const response = await h.claim();
  if (response.status !== 200)
    throw new Error(`${JSON.stringify(await h.queue.get(job.id))}`);
  const claimed = (await response.json()) as {
    job: { id: string; leaseToken: string };
  };
  expect(claimed.job.id).toBe(job.id);
  h.clock.advance(seconds * SECOND);
  const done = await h.complete(job.id, claimed.job.leaseToken, result);
  expect(done.status).toBe(200);
  return { job, claimed };
}

/** A push the claim refuses: the runner is handed nothing and the pull request gets its notice, whose text is returned. */
async function refuse(h: RunnerApiHarness, prNumber: number) {
  const job = await h.enqueueNew(pushOf(h, prNumber));
  expect((await h.claim()).status).toBe(204);
  await h.notices.settled();
  const comments = h.notices.comments(h.repository.fullName, prNumber);
  expect(comments).toHaveLength(1);
  return { job, notice: comments[0]?.body ?? "" };
}

afterEach(async () => {
  // #508-T10: after every journey the cached balance is the sum of the immutable entries, and nothing is held that nobody settles.
  for (const h of harnesses.splice(0)) {
    expect(await journalOf(h).verify()).toMatchObject({
      differenceMicroUsd: 0,
      reservedDifferenceMicroUsd: 0,
      strandedHoldCount: 0,
      consistent: true,
    });
  }
});

describe("billing journeys on the runner API", () => {
  // #508-T03
  it("a workspace on its own key pays infrastructure only, and a missing own key ends the job llm_not_configured without a charge", async () => {
    const h = await start({ keyMode: "own" });

    const { job } = await runReview(h, 20, withCost(0.04));

    // 90 seconds are 2 started minutes of Diff: 26,000. The AI cost of the customer's own key is not ours to bill.
    expect(await usageOf(h, job.id)).toEqual([
      { type: "usage", amount: -26_000, ai: 0, infra: 26_000 },
    ]);
    expect(await balanceOf(h)).toBe(FUNDING - 26_000);

    // The same workspace without a stored key: its choice is the own key, so there is no fallback to ours, and nothing is charged.
    const missing = await start({ keyMode: "own", ownKey: false });
    const refused = await missing.enqueueNew(pushOf(missing, 26, "a"));
    expect((await missing.claim()).status).toBe(204);
    expect(await missing.queue.get(refused.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(await usageOf(missing, refused.id)).toEqual([]);
    expect(await balanceOf(missing)).toBe(FUNDING);
    expect((await journalOf(missing).verify()).strandedHoldCount).toBe(0);
  });

  // #508-T04
  it("a superseded run is charged AI plus minutes, a run with unknown cost its minutes only, and a run lost to an error on our side nothing", async () => {
    const h = await start({ keyMode: "managed" });

    // Superseded: claimed on a runner that accepts the supersede, replaced by a newer push, and the Worker still reports its result.
    const old = await h.enqueueNew(pushOf(h, 7, "a"));
    const claimed = await h.claimed(SUPERSEDING_CLAIM);
    h.clock.advance(90 * SECOND);
    await h.enqueueNew(pushOf(h, 7, "c"));
    expect(await h.queue.get(old.id)).toMatchObject({ status: "superseded" });
    expect(
      (await h.complete(old.id, claimed.job.leaseToken, withCost(0.04))).status,
    ).toBe(200);
    // AI 0.04 x 5.0 = 200,000, and 2 started minutes of Diff.
    expect(await usageOf(h, old.id)).toEqual([
      { type: "usage", amount: -226_000, ai: 200_000, infra: 26_000 },
    ]);

    // The push that replaced it is a review of its own, charged on its own: 1 started minute and AI 0.01 x 5.0.
    const replacement = await h.claimed();
    h.clock.advance(30 * SECOND);
    await h.complete(
      replacement.job.id,
      replacement.job.leaseToken,
      withCost(0.01),
    );
    expect(await usageOf(h, replacement.job.id)).toEqual([
      { type: "usage", amount: -63_000, ai: 50_000, infra: 13_000 },
    ]);

    // Unknown cost: the AI part cannot be priced, the minutes are charged.
    const unknown = await runReview(h, 21, withCost(null));
    expect(await usageOf(h, unknown.job.id)).toEqual([
      { type: "usage", amount: -26_000, ai: 0, infra: 26_000 },
    ]);

    // An error on our side: nothing is charged, whatever the model cost before it.
    const ours = await runReview(
      h,
      22,
      goodResult({
        ok: false,
        errorCode: "runner_error",
        commentUrl: null,
        usage: { ...goodResult().usage!, costUsd: 0.5 },
      }),
    );
    expect(await usageOf(h, ours.job.id)).toEqual([]);

    expect(await balanceOf(h)).toBe(FUNDING - 226_000 - 63_000 - 26_000);
  });

  // #508-T06
  it("the monthly total limit and the hourly brake refuse and then stop refusing, and no number is in any notice", async () => {
    const h = await start({ hourlyReviewLimit: 2 });
    const settings = createBillingWorkspaceSettingsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    );

    // The monthly limit: a run is allowed to cost more than what is left of it, then the next one is refused.
    await settings.setMonthlyLimit(1_000_000, null);
    await runReview(h, 20, withCost(0.2), 30);
    const limited = await refuse(h, 23);
    expect(limited.notice).toContain("monthly spending limit");
    expect(await h.queue.get(limited.job.id)).toMatchObject({
      status: "failed",
      errorCode: "monthly_limit_reached",
    });
    await settings.setMonthlyLimit(null, null);

    // The hourly brake: one review was started in the last hour (the first), a second one passes, the third is paused.
    await runReview(h, 22, withCost(0.01), 30);
    const paused = await refuse(h, 24);
    expect(paused.notice).toContain("paused for this workspace for a while");
    expect(await h.queue.get(paused.job.id)).toMatchObject({
      status: "failed",
      errorCode: "reviews_paused",
    });

    // Neither notice names a number: not the limit, not an amount, not the brake's count or its window (the link, if any, is not text).
    for (const { notice } of [limited, paused]) {
      const text = notice.replace(/\(https?:\/\/[^)]*\)/g, "");
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/\$/);
      expect(text.toLowerCase()).not.toMatch(/brake|hour/);
    }

    // After the window the brake stops refusing.
    h.clock.advance(61 * MINUTE);
    const again = await h.enqueueNew(pushOf(h, 25, "a"));
    const claimed = await h.claimed();
    expect(claimed.job.id).toBe(again.id);
  });

  // #508-T09
  it("switching billing off and on again keeps the balance and the journal, and a run made while it was off is not charged", async () => {
    const h = await start({ keyMode: "managed" });
    const first = await runReview(h, 20, withCost(0.04));
    const balance = await balanceOf(h);
    const entries = (await journalOf(h).entries({ limit: 100 })).entries;
    expect(balance).toBe(FUNDING - 226_000);

    await setBillingSwitch(h.db, false, TEST_BILLING_RATES);
    const whileOff = await runReview(h, 21, withCost(0.04));
    expect(await usageOf(h, whileOff.job.id)).toEqual([]);
    expect(await balanceOf(h)).toBe(balance);

    await setBillingSwitch(h.db, true);
    expect(await balanceOf(h)).toBe(balance);
    expect((await journalOf(h).entries({ limit: 100 })).entries).toEqual(
      entries,
    );
    expect(await usageOf(h, first.job.id)).toHaveLength(1);
    // And it goes on charging as before.
    const after = await runReview(h, 22, withCost(0.04));
    expect(await usageOf(h, after.job.id)).toHaveLength(1);
    expect(await balanceOf(h)).toBe(balance - 226_000);
  });

  // #508-T11
  it("is guarded: no connection to anything but the loopback is possible in a journey", async () => {
    await expect(
      fetch("https://api.stripe.com/v1/balance"),
    ).rejects.toMatchObject({
      cause: { code: "NETWORK_GUARD_BLOCKED" },
    });
  });
});
