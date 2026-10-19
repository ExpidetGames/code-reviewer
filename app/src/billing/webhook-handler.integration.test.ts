// SPDX-License-Identifier: Apache-2.0

// #497: the generic billing webhook handler behind `POST /api/billing/webhook`, on SQLite and on Postgres, with the fake
// adapter. It checks the signature through the adapter, applies the one normalized event in one transaction and answers a
// code, never anything of the request.
import type { Kysely, KyselyPlugin } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { createBillingJournalRepository } from "../db/repositories/billing-journal-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import type { Database } from "../db/schema.ts";
import {
  BILLING_ENGINES,
  type BillingEngine,
} from "../test-support/billing-engines.ts";
import { setBillingSwitch } from "../test-support/billing-switch.ts";
import { describeQuery } from "../test-support/query-hook.ts";
import {
  createFakeBillingAdapter,
  fakeBodyBytes,
  fakeBodyText,
  fakeWebhookRequest,
  signFakeBody,
  type FakeWireEvent,
} from "../test-support/fake-billing-adapter.ts";
import type { BillingAdapter } from "./adapter.ts";
import { isBillingOn } from "./enabled.ts";
import { manualAdapter } from "./manual-adapter.ts";
import {
  createBillingWebhookHandler,
  type BillingWebhookLogger,
} from "./webhook-handler.ts";

const USD = 1_000_000;
const NOW = new Date("2026-10-19T08:00:00.000Z");
const T = NOW.toISOString();
const SECRET_BODY_MARKER = "customer-detail-that-must-not-leak";

class NotFound extends Error {}

function recordingLogger() {
  const lines: string[] = [];
  const logger: BillingWebhookLogger = {
    info: (line) => lines.push(`info ${line}`),
    error: (line) => lines.push(`error ${line}`),
  };
  return { lines, logger };
}

/** The tables the statements of a run touched. */
function tablesTouchedBy(db: Kysely<Database>, tables: string[]): KyselyPlugin {
  return {
    transformQuery({ node }) {
      const table = describeQuery(node).table;
      if (table !== undefined) tables.push(table);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
}

function suite(engine: BillingEngine) {
  describe.skipIf(engine.skip)(`the billing webhook on ${engine.name}`, () => {
    async function setup(
      options: { adapter?: BillingAdapter | undefined; on?: boolean } = {},
    ) {
      const { db, workspaceId, otherWorkspaceId } = await engine.create();
      if (options.on !== false) await setBillingSwitch(db, true);
      const { lines, logger } = recordingLogger();
      const adapter =
        "adapter" in options ? options.adapter : createFakeBillingAdapter();
      const build = (handlerDb: Kysely<Database>) =>
        createBillingWebhookHandler({
          db: handlerDb,
          guard: {
            isOn: () => isBillingOn(handlerDb),
            notFound: () => {
              throw new NotFound("not found");
            },
          },
          activeAdapter: () => Promise.resolve(adapter),
          logger,
          now: () => NOW,
        });
      const intent = await createBillingTopUpIntentsRepository(
        db,
        workspaceId,
      ).create({
        adapter: "fake",
        amountMicroUsd: 25 * USD,
      });
      const journal = createBillingJournalRepository(db, workspaceId);
      const payment: FakeWireEvent = {
        id: "evt_1",
        kind: "payment",
        created: T,
        intent: intent.id,
        payment: "pi_1",
        checkout: "cs_1",
        net: 25 * USD,
        gross: 29_750_000,
        tax: 4_750_000,
      };
      const post = (
        handler: (request: Request) => Promise<Response>,
        request: { headers: Headers; rawBody: Uint8Array },
      ) =>
        handler(
          new Request("https://app.example.test/api/billing/webhook", {
            method: "POST",
            headers: request.headers,
            body: request.rawBody,
          }),
        );
      return {
        db,
        workspaceId,
        otherWorkspaceId,
        lines,
        build,
        handler: build(db),
        intent,
        journal,
        payment,
        post,
      };
    }

    // #497-T01
    it("answers the missing path while billing is off, reads no billing table and calls nobody", async () => {
      const verify = vi.fn();
      const spy = vi.spyOn(globalThis, "fetch");
      const tables: string[] = [];
      try {
        const s = await setup({
          on: false,
          adapter: {
            ...createFakeBillingAdapter(),
            verifyAndParseWebhook: verify,
          },
        });
        const handler = s.build(s.db.withPlugin(tablesTouchedBy(s.db, tables)));

        await expect(
          s.post(handler, fakeWebhookRequest(s.payment)),
        ).rejects.toBeInstanceOf(NotFound);

        expect(verify).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();
        // The one thing read is the switch, which is an instance setting, not a billing table.
        expect(tables.filter((table) => table.startsWith("billing_"))).toEqual(
          [],
        );
        expect(await s.journal.balance()).toEqual({
          balanceMicroUsd: 0,
          reservedMicroUsd: 0,
        });
      } finally {
        spy.mockRestore();
      }
    });

    // #497-T01
    it("answers the missing path when the active adapter is manual, which has no webhook, or none is active", async () => {
      const manual = await setup({ adapter: manualAdapter });
      const none = await setup({ adapter: undefined });

      await expect(
        manual.post(manual.handler, fakeWebhookRequest(manual.payment)),
      ).rejects.toBeInstanceOf(NotFound);
      await expect(
        none.post(none.handler, fakeWebhookRequest(none.payment)),
      ).rejects.toBeInstanceOf(NotFound);
    });

    // #497-T02
    it("answers 401 with an empty body for a missing, wrong or altered signature, and changes nothing", async () => {
      const s = await setup();
      const good = fakeWebhookRequest(s.payment);
      const requests = [
        { headers: new Headers(), rawBody: good.rawBody },
        fakeWebhookRequest(s.payment, "another-secret"),
        {
          headers: good.headers,
          rawBody: fakeBodyBytes(
            fakeBodyText(good.rawBody).replace("25000000", "50000000"),
          ),
        },
        {
          headers: new Headers({ "x-fake-signature": "not-hex" }),
          rawBody: good.rawBody,
        },
      ];

      for (const request of requests) {
        const response = await s.post(s.handler, request);
        expect(response.status).toBe(401);
        expect(await response.text()).toBe("");
      }

      expect(await s.journal.balance()).toEqual({
        balanceMicroUsd: 0,
        reservedMicroUsd: 0,
      });
      expect(
        await s.db.selectFrom("billing_webhook_events").selectAll().execute(),
      ).toEqual([]);
      expect(
        (
          await createBillingTopUpIntentsRepository(s.db, s.workspaceId).get(
            s.intent.id,
          )
        )?.state,
      ).toBe("pending");
    });

    // #497-T02
    it("logs a code for a refused request and never the body, the signature or the secret", async () => {
      const s = await setup();
      const request = fakeWebhookRequest(
        JSON.stringify({ ...s.payment, note: SECRET_BODY_MARKER }),
        "another-secret",
      );

      await s.post(s.handler, request);
      await s.post(s.handler, {
        headers: new Headers(),
        rawBody: request.rawBody,
      });
      const ok = fakeWebhookRequest({
        ...s.payment,
        note: SECRET_BODY_MARKER,
      } as FakeWireEvent);
      await s.post(s.handler, ok);

      const log = s.lines.join("\n");
      expect(log).toContain("signature_invalid");
      expect(log).toContain("signature_missing");
      for (const forbidden of [
        SECRET_BODY_MARKER,
        request.headers.get("x-fake-signature") ?? "?",
        "fake-webhook-secret",
        "pi_1",
        s.intent.id,
      ])
        expect(log).not.toContain(forbidden);
    });

    // #497-T02
    it("answers 400 with an empty body for a signed body the adapter cannot read, and 413 for a body that is too large", async () => {
      const s = await setup();

      const unreadable = await s.post(
        s.handler,
        fakeWebhookRequest("not json"),
      );
      expect(unreadable.status).toBe(400);
      expect(await unreadable.text()).toBe("");

      const huge = fakeWebhookRequest("x".repeat(300 * 1024));
      const tooLarge = await s.post(s.handler, huge);
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.text()).toBe("");
    });

    // #497-T03
    it("applies a signed payment and answers 200 with the outcome code", async () => {
      const s = await setup();

      const response = await s.post(s.handler, fakeWebhookRequest(s.payment));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "applied" });
      expect((await s.journal.balance()).balanceMicroUsd).toBe(25 * USD);
    });

    // #497-T04
    it("answers 200 to a repeat and applies a payment once when the same request arrives many times at once", async () => {
      const s = await setup();
      const request = fakeWebhookRequest(s.payment);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => s.post(s.handler, request)),
      );

      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200, 200, 200, 200,
      ]);
      const outcomes = await Promise.all(
        responses.map(
          async (response) =>
            ((await response.json()) as { outcome: string }).outcome,
        ),
      );
      expect(outcomes.filter((outcome) => outcome === "applied")).toHaveLength(
        1,
      );
      expect(
        outcomes.filter((outcome) => outcome === "duplicate_ignored"),
      ).toHaveLength(5);
      expect((await s.journal.balance()).balanceMicroUsd).toBe(25 * USD);
    });

    // #497-T09
    it("answers 200 intent_unresolved for a payment of an intent that is not ours", async () => {
      const s = await setup();

      const response = await s.post(
        s.handler,
        fakeWebhookRequest({
          ...s.payment,
          intent: "no-such-intent",
          checkout: null,
        } as FakeWireEvent),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "intent_unresolved" });
      expect((await s.journal.balance()).balanceMicroUsd).toBe(0);
    });

    // #497-T10
    it("answers 500 with an empty body when the database fails, applies nothing, and applies the redelivery", async () => {
      const s = await setup();
      const armed = { on: true };
      const failing = s.db.withPlugin({
        transformQuery({ node }) {
          const info = describeQuery(node);
          if (
            armed.on &&
            info.kind === "update" &&
            info.table === "billing_topup_intents"
          )
            throw new Error(`injected failure ${SECRET_BODY_MARKER}`);
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      });
      const handler = s.build(failing);
      const request = fakeWebhookRequest(s.payment);

      const failed = await s.post(handler, request);

      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe("");
      expect((await s.journal.balance()).balanceMicroUsd).toBe(0);
      expect(
        await s.db.selectFrom("billing_webhook_events").selectAll().execute(),
      ).toEqual([]);
      // The log names a code, not the error.
      expect(s.lines.join("\n")).toContain("billing_webhook_failed");
      expect(s.lines.join("\n")).not.toContain(SECRET_BODY_MARKER);

      armed.on = false;
      const redelivered = await s.post(handler, request);
      expect(redelivered.status).toBe(200);
      expect(await redelivered.json()).toEqual({ outcome: "applied" });
      expect((await s.journal.balance()).balanceMicroUsd).toBe(25 * USD);
    });

    // #497-T10
    it("answers 500 when the adapter itself throws, with a code in the log", async () => {
      const adapter: BillingAdapter = {
        ...createFakeBillingAdapter(),
        verifyAndParseWebhook: () =>
          Promise.reject(new Error(SECRET_BODY_MARKER)),
      };
      const s = await setup({ adapter });

      const response = await s.post(s.handler, fakeWebhookRequest(s.payment));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
      expect(s.lines.join("\n")).toContain("billing_webhook_adapter_failed");
      expect(s.lines.join("\n")).not.toContain(SECRET_BODY_MARKER);
    });

    // #497-T09
    it("answers 200 event_invalid for a signed event that is not a normalized event, records it, and raises a code in the log", async () => {
      const adapter: BillingAdapter = {
        ...createFakeBillingAdapter(),
        verifyAndParseWebhook: () =>
          Promise.resolve({
            ok: true,
            event: {
              type: "payment.succeeded",
              eventId: "evt_x",
              occurredAt: T,
              intentId: null,
              payment: "pi_x",
              checkout: null,
              creditable: 1.5 as never,
              gross: 2 as never,
              tax: null,
            },
          }),
      };
      const s = await setup({ adapter });

      const response = await s.post(s.handler, fakeWebhookRequest(s.payment));
      const repeat = await s.post(s.handler, fakeWebhookRequest(s.payment));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "event_invalid" });
      expect(repeat.status).toBe(200);
      expect(s.lines).toContain("error billing_webhook_event_invalid");
      expect(
        await s.db.selectFrom("billing_webhook_events").selectAll().execute(),
      ).toMatchObject([{ event_id: "evt_x", outcome: "event_invalid" }]);
    });

    // #497-T09
    it("logs a paid-but-not-credited outcome at error level with its code, and a benign outcome at info", async () => {
      const s = await setup();

      await s.post(
        s.handler,
        fakeWebhookRequest({
          ...s.payment,
          intent: "nobody",
          checkout: null,
          payment: "pi_nobody",
        }),
      );
      await s.post(
        s.handler,
        fakeWebhookRequest({ id: "evt_2", kind: "other", created: T }),
      );

      expect(s.lines).toContain(
        "error billing_webhook_needs_review outcome=intent_unresolved",
      );
      expect(s.lines).toContain(
        "info billing_webhook_applied outcome=ignored_type",
      );
      expect(s.lines.join("\n")).not.toContain("pi_nobody");
    });

    // #497-T02
    it("hands the adapter the exact bytes of the body: a byte order mark and bytes that are not UTF-8 survive", async () => {
      const seen: Uint8Array[] = [];
      const adapter: BillingAdapter = {
        ...createFakeBillingAdapter(),
        verifyAndParseWebhook: ({ rawBody }) => {
          seen.push(rawBody);
          return Promise.resolve({ ok: false, code: "signature_invalid" });
        },
      };
      const s = await setup({ adapter });
      const bytes = new Uint8Array([
        0xef, 0xbb, 0xbf, 0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d,
      ]);

      await s.post(s.handler, { headers: new Headers(), rawBody: bytes });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(Uint8Array);
      expect([...(seen[0] ?? [])]).toEqual([...bytes]);
      expect(signFakeBody(bytes)).toMatch(/^[0-9a-f]{64}$/);
    });

    // #497-T13
    it("makes no outbound call", async () => {
      const spy = vi.spyOn(globalThis, "fetch");
      try {
        const s = await setup();
        await s.post(s.handler, fakeWebhookRequest(s.payment));
        await s.post(
          s.handler,
          fakeWebhookRequest(s.payment, "another-secret"),
        );
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
}

for (const engine of BILLING_ENGINES) suite(engine);
