// SPDX-License-Identifier: Apache-2.0

// The list of billing review rows in the admin portal, over a real database, the real proxy and the real data routes (#603):
// the rows an operator has to look at with what is needed to act on them, closing a row with a note and the admin as the
// actor, the manual credit that repairs it (one entry however often it is sent), the repair by asking the payment provider
// again, that only an instance admin reaches any of it, and that nothing of a payment's payload or a buyer is shown.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";
import type { Database } from "../db/schema.ts";
import { createAdminHarness } from "../test-support/admin-harness.ts";
import type { BillingAdapter } from "./adapter.ts";
import type { TopUpCheckService } from "./topup-check.ts";

const MEMBER = { email: "member@example.com", password: "k4Pq-v8Zm2Xw" };
const USD = 1_000_000;
const LIST = "/api/admin/billing/reviews";
const RESOLVE = "/api/admin/billing/reviews/resolve";
const CHECK = "/api/admin/billing/reviews/check";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the shape is asserted field by field

type CheckCall = Parameters<TopUpCheckService["check"]>;

async function start(
  options: {
    check?: { result: Awaited<ReturnType<TopUpCheckService["check"]>> };
  } = {},
) {
  const checkCalls: CheckCall[] = [];
  const stripeAdapter = {
    id: "stripe",
    lookupTopUp: () => Promise.resolve(null),
  } as unknown as BillingAdapter;
  const portal = await createAdminHarness({
    reviewCheck:
      options.check === undefined
        ? undefined
        : {
            adapter: () => Promise.resolve(stripeAdapter),
            serviceFor: () => ({
              check: (...args: CheckCall) => {
                checkCalls.push(args);
                return Promise.resolve(options.check!.result);
              },
            }),
          },
  });
  const db: Kysely<Database> = portal.db;
  const events = createBillingWebhookEventsRepository(db);

  async function workspace(name: string) {
    const id = `ws-${name}`;
    await db
      .insertInto("workspaces")
      .values({
        id,
        name,
        slug: name.toLowerCase(),
        created_by: null,
        created_at: "2026-10-20T08:00:00.000Z",
      })
      .execute();
    return id;
  }

  async function intent(workspaceId: string, id: string, amount = 25 * USD) {
    return createBillingTopUpIntentsRepository(db, workspaceId).create({
      id,
      adapter: "stripe",
      amountMicroUsd: amount,
    });
  }

  async function review(
    eventId: string,
    options: {
      at?: string;
      outcome?: "amount_rejected" | "intent_unresolved" | "amount_conflict";
      subject?: string | null;
      workspaceId?: string;
      intentId?: string;
    } = {},
  ) {
    await events.claim(
      "stripe",
      eventId,
      options.at ?? "2026-10-21T08:00:00.000Z",
    );
    await events.finish(
      "stripe",
      eventId,
      options.outcome ?? "amount_rejected",
      { subject: options.subject ?? null, occurredAt: null },
      true,
      options.workspaceId === undefined && options.intentId === undefined
        ? undefined
        : {
            workspaceId: options.workspaceId ?? null,
            intentId: options.intentId ?? null,
          },
    );
  }

  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    portal.visit(path, { cookies: portal.adminCookies, ...init });
  const list = async (query = "") =>
    (await (await call(`${LIST}${query}`)).json()) as Json;
  const resolve = (body: unknown) => call(RESOLVE, { method: "POST", body });
  const entriesOf = async (workspaceId: string) =>
    (
      await createBillingJournalRepository(db, workspaceId).entries({
        limit: 20,
      })
    ).entries;

  return {
    portal,
    db,
    events,
    checkCalls,
    workspace,
    intent,
    review,
    call,
    list,
    resolve,
    entriesOf,
  };
}

/** A workspace with an open intent and a refused payment on it: the case the page exists for. */
async function refusedPayment(s: Awaited<ReturnType<typeof start>>) {
  const workspaceId = await s.workspace("Acme");
  await s.intent(workspaceId, "intent-1");
  await s.review("evt_refused", {
    subject: "payment:pi_1",
    workspaceId,
    intentId: "intent-1",
  });
  return workspaceId;
}

describe("the list of billing review rows", () => {
  // #603-T01
  it("shows the open rows newest first with the outcome, the Stripe object, the workspace and the intent where known and when it arrived", async () => {
    const s = await start();
    const acme = await refusedPayment(s);
    await s.review("evt_later", {
      at: "2026-10-21T09:00:00.000Z",
      outcome: "intent_unresolved",
      subject: "refund:re_9",
    });

    const answer = await s.list();

    expect(answer).toMatchObject({
      state: "open",
      page: 1,
      total: 2,
      openTotal: 2,
    });
    expect(answer.rows.map((row: Json) => row.eventId)).toEqual([
      "evt_later",
      "evt_refused",
    ]);
    expect(answer.rows[1]).toMatchObject({
      provider: "stripe",
      eventId: "evt_refused",
      outcome: "amount_rejected",
      subject: { kind: "payment", ref: "pi_1" },
      workspace: { id: acme, name: "Acme", slug: "acme" },
      intent: { id: "intent-1", state: "pending", amountMicroUsd: 25 * USD },
      receivedAt: "2026-10-21T08:00:00.000Z",
      state: "open",
      resolution: null,
    });
  });

  // #603-T04
  it("lists the row of a payment that is none of ours without a workspace and an intent", async () => {
    const s = await start();
    await s.review("evt_foreign", {
      outcome: "intent_unresolved",
      subject: "payment:pi_foreign",
    });

    const answer = await s.list();

    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0]).toMatchObject({
      eventId: "evt_foreign",
      subject: { kind: "payment", ref: "pi_foreign" },
      workspace: null,
      intent: null,
      suggestion: null,
    });
  });

  // #603-T07
  it("pages the list, filters it by state and counts what is open", async () => {
    const s = await start();
    for (let index = 0; index < 30; index += 1)
      await s.review(`evt_${String(index).padStart(2, "0")}`, {
        at: `2026-10-21T08:${String(index).padStart(2, "0")}:00.000Z`,
      });
    await s.events.resolveReview("stripe", "evt_00", {
      resolvedBy: "u",
      note: "n",
      entryId: null,
      at: "2026-10-21T12:00:00.000Z",
    });

    const first = await s.list("?page=1");
    const second = await s.list("?page=2");
    const closed = await s.list("?state=resolved");

    expect(first).toMatchObject({ total: 29, openTotal: 29, pageSize: 25 });
    expect(first.rows).toHaveLength(25);
    expect(first.rows[0].eventId).toBe("evt_29");
    expect(second.rows).toHaveLength(4);
    expect(closed).toMatchObject({
      state: "resolved",
      total: 1,
      openTotal: 29,
    });
    expect(closed.rows.map((row: Json) => row.eventId)).toEqual(["evt_00"]);
  });

  // #603-T07
  it("refuses a state or a page it does not know", async () => {
    const s = await start();

    const state = await s.call(`${LIST}?state=all`);
    const page = await s.call(`${LIST}?page=0`);

    expect(state.status).toBe(422);
    expect(await state.json()).toMatchObject({ error: "invalid_input" });
    expect(page.status).toBe(422);
  });

  // #603-T14
  it("suggests the credit of the intent for a refused payment and only a correction, without an amount, for a refund", async () => {
    const s = await start();
    const acme = await refusedPayment(s);
    await s.review("evt_refund", {
      at: "2026-10-21T09:00:00.000Z",
      outcome: "intent_unresolved",
      subject: "refund:re_1",
      workspaceId: acme,
    });

    const answer = await s.list();

    const byId = (id: string) =>
      answer.rows.find((row: Json) => row.eventId === id);
    expect(byId("evt_refused").suggestion).toEqual({
      type: "credit",
      amountMicroUsd: 25 * USD,
    });
    expect(byId("evt_refund").suggestion).toEqual({
      type: "correction",
      amountMicroUsd: null,
    });
  });

  // #603-T05
  it("carries nothing but the stored fields: no payload, no buyer, no amount the provider sent", async () => {
    const s = await start();
    await refusedPayment(s);
    await s.events.resolveReview("stripe", "evt_refused", {
      resolvedBy: "admin",
      note: "credited by hand",
      entryId: null,
      at: "2026-10-21T12:00:00.000Z",
    });

    const answers = [
      await (await s.call(LIST)).text(),
      await (await s.call(`${LIST}?state=resolved`)).text(),
    ].join("\n");

    const keys = new Set<string>();
    const collect = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (typeof value === "object" && value !== null)
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          collect(inner);
        }
    };
    for (const text of answers.split("\n")) collect(JSON.parse(text));
    expect([...keys].sort()).toEqual(
      [
        "amountMicroUsd",
        "at",
        "byName",
        "checkoutRef",
        "entryId",
        "eventId",
        "id",
        "intent",
        "name",
        "note",
        "openTotal",
        "outcome",
        "page",
        "pageSize",
        "paymentRef",
        "provider",
        "receivedAt",
        "ref",
        "kind",
        "resolution",
        "rows",
        "slug",
        "state",
        "subject",
        "suggestion",
        "total",
        "type",
        "workspace",
      ].sort(),
    );
    expect(answers).not.toMatch(/@|payload|email|address|customer/i);
  });
});

describe("closing a billing review row", () => {
  // #603-T02
  it("closes the row with the note and the admin as the actor, keeps the outcome and the event id and changes no money", async () => {
    const s = await start();
    const acme = await refusedPayment(s);

    const first = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "  Refunded at Stripe by hand  ",
    });
    const second = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "again",
    });

    expect(first.status).toBe(200);
    const body = (await first.json()) as Json;
    expect(body.ok).toBe(true);
    expect(body.review).toMatchObject({
      eventId: "evt_refused",
      outcome: "amount_rejected",
      state: "resolved",
      resolution: { note: "Refunded at Stripe by hand", entryId: null },
    });
    expect(body.review.resolution.byName).toEqual(expect.any(String));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "review_already_resolved" });
    expect((await s.list()).rows).toEqual([]);
    const closed = await s.list("?state=resolved");
    expect(closed.rows).toHaveLength(1);
    expect(closed.rows[0].resolution.note).toBe("Refunded at Stripe by hand");
    expect(await s.entriesOf(acme)).toEqual([]);
    const stored = await s.events.getReview("stripe", "evt_refused");
    expect(stored?.resolution?.resolvedBy).toBe(s.portal.adminId);
  });

  // #603-T08
  it("refuses a close without a note or with one that is too long, and leaves the row open", async () => {
    const s = await start();
    await refusedPayment(s);

    const none = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
    });
    const blank = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "   ",
    });
    const long = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "x".repeat(501),
    });

    expect(none.status).toBe(422);
    expect(await none.json()).toMatchObject({
      error: "invalid_input",
      issues: [{ field: "note", code: "note_required" }],
    });
    expect(blank.status).toBe(422);
    expect(await long.json()).toMatchObject({
      issues: [{ field: "note", code: "note_too_long" }],
    });
    expect((await s.list()).total).toBe(1);
  });

  // #603-T08
  it("answers a row that does not exist or is not under review with a stable code", async () => {
    const s = await start();
    await s.review("evt_x");
    await s.events.claim("stripe", "evt_fine", "2026-10-21T08:00:00.000Z");
    await s.events.finish("stripe", "evt_fine", "applied", {
      subject: null,
      occurredAt: null,
    });

    const unknown = await s.resolve({
      provider: "stripe",
      eventId: "evt_nope",
      note: "n",
    });
    const fine = await s.resolve({
      provider: "stripe",
      eventId: "evt_fine",
      note: "n",
    });
    const strange = await s.resolve({
      provider: 4,
      eventId: "evt_x",
      note: "n",
    });
    const extra = await s.resolve({
      provider: "stripe",
      eventId: "evt_x",
      note: "n",
      workspaceId: "ws-other",
    });

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "review_not_found" });
    expect(fine.status).toBe(404);
    expect(strange.status).toBe(422);
    expect(extra.status).toBe(422);
    expect((await s.events.getReview("stripe", "evt_x"))?.reviewState).toBe(
      "open",
    );
  });

  // #603-T11
  it("writes one audit line with the actor and the event, never the note", async () => {
    const s = await start();
    await refusedPayment(s);
    s.portal.billingCreditLog.length = 0;

    await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "Anna Example paid twice",
    });
    const lines = s.portal.billingCreditLog;

    expect(lines.join("\n")).toContain(
      `billing_review_resolved provider=stripe event=evt_refused actor=${s.portal.adminId}`,
    );
    expect(lines.join("\n")).not.toContain("Anna");
  });
});

describe("repairing a billing review row with a manual credit", () => {
  // #603-T09
  it("credits the workspace of the row through the manual adapter with the admin as the actor and closes the row with the entry", async () => {
    const s = await start();
    const acme = await refusedPayment(s);

    const response = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "Paid 12.50 after a coupon, credited",
      credit: { type: "credit", amountMicroUsd: 12_500_000 },
    });

    expect(response.status).toBe(200);
    const entries = await s.entriesOf(acme);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "top_up",
      amountMicroUsd: 12_500_000,
      provider: "manual",
      actorUserId: s.portal.adminId,
      note: "Paid 12.50 after a coupon, credited",
    });
    const body = (await response.json()) as Json;
    expect(body.review.resolution.entryId).toBe(entries[0]!.id);
    expect(body.review.state).toBe("resolved");
  });

  // #603-T10
  it("never credits twice: a second send, and a send after the close was lost, leave one entry", async () => {
    const s = await start();
    const acme = await refusedPayment(s);
    const send = () =>
      s.resolve({
        provider: "stripe",
        eventId: "evt_refused",
        note: "credited",
        credit: { type: "credit", amountMicroUsd: 12_500_000 },
      });

    const first = await send();
    const second = await send();
    // The close is lost after the credit was written: the row is open again, the retry finds the same entry.
    await s.db
      .updateTable("billing_webhook_events")
      .set({ review_state: "open", resolved_at: null, resolved_by: null })
      .execute();
    const retried = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(retried.status).toBe(200);
    const entries = await s.entriesOf(acme);
    expect(entries).toHaveLength(1);
    expect(((await retried.json()) as Json).review.resolution.entryId).toBe(
      entries[0]!.id,
    );
  });

  // #603-T10
  it("refuses a retry with another amount and writes nothing more", async () => {
    const s = await start();
    const acme = await refusedPayment(s);
    await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "credited",
      credit: { type: "credit", amountMicroUsd: 12_500_000 },
    });
    await s.db
      .updateTable("billing_webhook_events")
      .set({ review_state: "open", resolved_at: null, resolved_by: null })
      .execute();

    const other = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "credited",
      credit: { type: "credit", amountMicroUsd: 20_000_000 },
    });

    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "request_conflict" });
    expect(await s.entriesOf(acme)).toHaveLength(1);
    expect(
      (await s.events.getReview("stripe", "evt_refused"))?.reviewState,
    ).toBe("open");
  });

  // #603-T12
  it("credits only the workspace the row names and refuses a credit for a row with none", async () => {
    const s = await start();
    await s.review("evt_foreign", {
      outcome: "intent_unresolved",
      subject: "payment:pi_foreign",
    });

    const response = await s.resolve({
      provider: "stripe",
      eventId: "evt_foreign",
      note: "n",
      credit: { type: "credit", amountMicroUsd: USD },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "review_workspace_unknown",
    });
    expect(
      (await s.events.getReview("stripe", "evt_foreign"))?.reviewState,
    ).toBe("open");
  });

  // #603-T13
  it("refuses a credit the manual credit refuses, with the field, and leaves the row open and the journal empty", async () => {
    const s = await start();
    const acme = await refusedPayment(s);

    const zero = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "n",
      credit: { type: "credit", amountMicroUsd: 0 },
    });
    const kind = await s.resolve({
      provider: "stripe",
      eventId: "evt_refused",
      note: "n",
      credit: { type: "refund", amountMicroUsd: USD },
    });

    expect(zero.status).toBe(422);
    expect(await zero.json()).toMatchObject({
      issues: [{ field: "amountMicroUsd", code: "amount_invalid" }],
    });
    expect(kind.status).toBe(422);
    expect(await s.entriesOf(acme)).toEqual([]);
    expect(
      (await s.events.getReview("stripe", "evt_refused"))?.reviewState,
    ).toBe("open");
  });

  // #603-T15
  it("writes a signed correction for a refund row", async () => {
    const s = await start();
    const acme = await refusedPayment(s);
    await s.review("evt_refund", {
      at: "2026-10-21T09:00:00.000Z",
      outcome: "intent_unresolved",
      subject: "refund:re_1",
      workspaceId: acme,
    });

    const response = await s.resolve({
      provider: "stripe",
      eventId: "evt_refund",
      note: "Refunded before the credit; take it back",
      credit: { type: "correction", amountMicroUsd: -5 * USD },
    });

    expect(response.status).toBe(200);
    expect(await s.entriesOf(acme)).toMatchObject([
      { type: "correction", amountMicroUsd: -5 * USD, provider: "manual" },
    ]);
  });
});

describe("checking a payment from a review row", () => {
  // #603-T16
  it("asks the provider about the intent of the row as an owner of its workspace and answers the state of the intent", async () => {
    const s = await start({
      check: { result: { ok: true, intentId: "intent-1", state: "paid" } },
    });
    const acme = await refusedPayment(s);

    const response = await s.call(CHECK, {
      method: "POST",
      body: { provider: "stripe", eventId: "evt_refused" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;
    expect(body).toMatchObject({ ok: true, intentState: "paid" });
    expect(body.review.eventId).toBe("evt_refused");
    expect(s.checkCalls).toEqual([
      [
        { workspaceId: acme, userId: s.portal.adminId, role: "owner" },
        "intent-1",
      ],
    ]);
    // Asking changes no review: the operator decides when it is dealt with.
    expect(
      (await s.events.getReview("stripe", "evt_refused"))?.reviewState,
    ).toBe("open");
  });

  // #603-T16
  it("has nothing to ask for a row that names no intent", async () => {
    const s = await start({
      check: { result: { ok: true, intentId: "x", state: "paid" } },
    });
    await s.review("evt_foreign", {
      outcome: "intent_unresolved",
      subject: "payment:pi_foreign",
    });

    const response = await s.call(CHECK, {
      method: "POST",
      body: { provider: "stripe", eventId: "evt_foreign" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "review_has_no_intent" });
    expect(s.checkCalls).toEqual([]);
  });

  // #603-T16
  it("says so when the provider cannot be asked, and when no payment adapter can look a payment up", async () => {
    const down = await start({
      check: { result: { ok: false, error: "provider_unavailable" } },
    });
    await refusedPayment(down);
    const none = await start();
    await refusedPayment(none);
    const body = { provider: "stripe", eventId: "evt_refused" };

    const unavailable = await down.call(CHECK, { method: "POST", body });
    const missing = await none.call(CHECK, { method: "POST", body });

    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toEqual({
      error: "payment_check_unavailable",
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({
      error: "payment_check_not_possible",
    });
  });
});

describe("who may use the review routes", () => {
  const ROUTES: Array<[string, string, unknown?]> = [
    ["GET", LIST],
    [
      "POST",
      RESOLVE,
      { provider: "stripe", eventId: "evt_refused", note: "n" },
    ],
    ["POST", CHECK, { provider: "stripe", eventId: "evt_refused" }],
  ];

  // #603-T03
  it("answers nobody without a session with 401", async () => {
    const s = await start();
    await refusedPayment(s);

    for (const [method, path, body] of ROUTES) {
      const response = await s.portal.visit(path, { method, body });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  // #603-T03
  it("answers a member who is not an admin like a path that does not exist and changes nothing", async () => {
    const s = await start();
    const acme = await refusedPayment(s);
    await s.portal.createUser({ id: "member", ...MEMBER });
    // A member, and an owner of the workspace the row belongs to: still not an instance admin.
    await s.db
      .updateTable("workspace_members")
      .set({ role: "owner" })
      .where("user_id", "=", "member")
      .execute();
    const cookies = await s.portal.signIn(MEMBER.email, MEMBER.password);

    for (const [method, path, body] of ROUTES) {
      const response = await s.portal.visit(path, { method, body, cookies });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("x-answer-of-a-missing-path")).toBe("1");
    }
    expect(
      (await s.events.getReview("stripe", "evt_refused"))?.reviewState,
    ).toBe("open");
    expect(await s.entriesOf(acme)).toEqual([]);
  });

  // #603-T03
  it("sends no-store with every answer, a refusal too", async () => {
    const s = await start();
    await refusedPayment(s);

    const answers = [
      await s.call(LIST),
      await s.call(`${LIST}?page=0`),
      await s.resolve({ provider: "stripe", eventId: "evt_refused" }),
      await s.call(CHECK, { method: "POST", body: {} }),
    ];

    for (const answer of answers)
      expect(answer.headers.get("cache-control")).toBe("no-store");
  });

  // #603-T03
  it("refuses a cross-site write", async () => {
    const s = await start();
    await refusedPayment(s);

    const response = await s.portal.visit(RESOLVE, {
      method: "POST",
      body: { provider: "stripe", eventId: "evt_refused", note: "n" },
      cookies: s.portal.adminCookies,
      headers: {
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cross_site_request" });
    expect(
      (await s.events.getReview("stripe", "evt_refused"))?.reviewState,
    ).toBe("open");
  });
});
