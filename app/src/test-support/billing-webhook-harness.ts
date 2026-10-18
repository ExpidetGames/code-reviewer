// SPDX-License-Identifier: Apache-2.0

// The webhook of billing (#441) on a real database with the fake Paddle's signer: a workspace pair, two plans with linked
// prices (made-up ids and amounts), checkouts, Paddle shaped events and signed requests. The handler under test is the real
// one; only the secret and the environment come from a stand-in for the settings, and the clock is moved by hand.
import type { Kysely, KyselyPlugin } from "kysely";
import {
  buildDeliveries,
  makeEvent,
  type DeliveryFault,
  type PaddleEvent,
} from "../../../fakes/paddle/webhooks.ts";
import type { PlanTerms } from "../admin/ui/plans-view.ts";
import {
  createBillingWebhookHandler,
  type BillingWebhookDeps,
  type WebhookLogger,
} from "../billing/webhook-handler.ts";
import { createBillingCheckoutsRepository } from "../db/repositories/billing-checkouts-repository.ts";
import { createBillingPlanPricesRepository } from "../db/repositories/billing-plan-prices-repository.ts";
import { createBillingPlanVersionsRepository } from "../db/repositories/billing-plan-versions-repository.ts";
import { createBillingPlansRepository } from "../db/repositories/billing-plans-repository.ts";
import { createBillingSubscriptionsRepository } from "../db/repositories/billing-subscriptions-repository.ts";
import type { Database } from "../db/schema.ts";
import { describeQuery } from "./query-hook.ts";
import { addWorkspace, defaultWorkspaceId } from "./workspaces.ts";

export const WEBHOOK_SECRET = "pdl_ntfset_test_secret_value";
export const WEBHOOK_URL = "https://app.test/api/billing/webhook";
export const NOW = new Date("2026-10-18T12:00:00.000Z");

const TERMS: PlanTerms = {
  keyMode: "managed",
  limits: {
    diffRunsPerPeriod: 40,
    dynamicRunsPerPeriod: 8,
    managedCostLimitMicroUsd: null,
    ownKeyCostLimitMicroUsd: null,
  },
  modelAccess: { catalogEntries: null },
  monthlyAmountMinor: 1234,
  yearlyAmountMinor: 12_340,
};

function priceSnapshot(interval: "month" | "year", amount: string) {
  return {
    productId: "pro_1",
    priceType: "standard",
    interval,
    frequency: 1,
    currency: "USD",
    amount,
    taxMode: "internal",
    hasOverrides: false,
    trialDays: null,
    status: "active",
    quantityMinimum: 1,
    quantityMaximum: 100,
  };
}

/** Paddle's microsecond timestamps: `2026-10-18T11:00:00.123456Z`. */
export function paddleTime(date: Date | string, microseconds = "123456") {
  const iso = typeof date === "string" ? date : date.toISOString();
  return iso.replace(/\.\d{3}Z$/, `.${microseconds}Z`);
}

export type SubscriptionDataOptions = {
  id?: string;
  status?: string;
  priceId?: string;
  customerId?: string;
  /** Only `subscription.created` carries it (Paddle's documentation). */
  transactionId?: string;
  startsAt?: string;
  endsAt?: string;
  scheduledChange?: { action: string; effective_at: string } | null;
  customData?: Record<string, unknown> | null;
  canceledAt?: string | null;
  /** Fields Paddle sends that the app must never keep (personal data, billing details). */
  extra?: Record<string, unknown>;
};

/** The `data` of a Paddle subscription event. */
export function subscriptionData(options: SubscriptionDataOptions = {}) {
  const data: Record<string, unknown> = {
    id: options.id ?? "sub_01fake1",
    status: options.status ?? "active",
    customer_id: options.customerId ?? "ctm_01fake1",
    address_id: "add_01fake1",
    business_id: null,
    currency_code: "USD",
    created_at: paddleTime("2026-10-18T10:00:00.000Z"),
    updated_at: paddleTime("2026-10-18T10:00:00.000Z"),
    started_at: paddleTime("2026-10-18T10:00:00.000Z"),
    first_billed_at: paddleTime("2026-10-18T10:00:00.000Z"),
    next_billed_at: paddleTime(options.endsAt ?? "2026-11-18T10:00:00.000Z"),
    paused_at: null,
    canceled_at: options.canceledAt ?? null,
    collection_mode: "automatic",
    billing_details: null,
    current_billing_period: {
      starts_at: paddleTime(options.startsAt ?? "2026-10-18T10:00:00.000Z"),
      ends_at: paddleTime(options.endsAt ?? "2026-11-18T10:00:00.000Z"),
    },
    billing_cycle: { interval: "month", frequency: 1 },
    scheduled_change: options.scheduledChange ?? null,
    items: [
      {
        status: "active",
        quantity: 1,
        recurring: true,
        price: {
          id: options.priceId ?? "pri_month",
          product_id: "pro_1",
          description: "made up",
          unit_price: { amount: "1234", currency_code: "USD" },
        },
      },
    ],
    custom_data: options.customData ?? null,
    import_meta: null,
    ...options.extra,
  };
  if (options.transactionId !== undefined)
    data.transaction_id = options.transactionId;
  return data;
}

/** The `data` of a Paddle price event: the full entity. */
export function priceData(
  paddleId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: paddleId,
    product_id: "pro_1",
    description: "made up",
    name: null,
    type: "standard",
    status: "active",
    tax_mode: "internal",
    billing_cycle: { interval: "month", frequency: 1 },
    trial_period: null,
    unit_price: { amount: "1234", currency_code: "USD" },
    quantity: { minimum: 1, maximum: 100 },
    unit_price_overrides: [],
    custom_data: null,
    created_at: paddleTime("2026-10-01T00:00:00.000Z"),
    updated_at: paddleTime("2026-10-18T11:00:00.000Z"),
    ...overrides,
  };
}

export type EventOptions = { at?: string; id?: string };

export function event(
  type: string,
  data: unknown,
  options: EventOptions = {},
): PaddleEvent {
  return makeEvent(type, data, {
    occurredAt: paddleTime(options.at ?? "2026-10-18T11:00:00.000Z"),
    ...(options.id === undefined ? {} : { eventId: options.id }),
  });
}

export type SendOptions = {
  fault?: DeliveryFault;
  secret?: string;
  /** The clock of the signature in ms; default the harness clock. */
  signedAt?: number;
  staleSeconds?: number;
  order?: "given" | "reversed";
  duplicates?: number;
};

export type WebhookHarnessOptions = {
  environment?: "sandbox" | "live";
  toleranceSeconds?: number;
  maxBodyBytes?: number;
};

/** Everything a webhook test needs, on the database `db` (already migrated). */
export async function startWebhookHarness(
  db: Kysely<Database>,
  options: WebhookHarnessOptions = {},
) {
  const workspaceA = await defaultWorkspaceId(db);
  const workspaceB = await addWorkspace(db, "other");
  const plans = createBillingPlansRepository(db);
  const versions = createBillingPlanVersionsRepository(db);
  // The caches were read before any event of the tests (they occur from 11:00 on).
  const prices = createBillingPlanPricesRepository(
    db,
    () => new Date("2026-10-18T09:00:00.000Z"),
  );
  const metadata = {
    name: "Team",
    description: "",
    sort: 1,
    offered: true,
    popular: false,
    contactTarget: null,
  };
  const team = await plans.insert(
    { planKey: "team", kind: "paid", metadata },
    null,
  );
  const pro = await plans.insert(
    { planKey: "pro", kind: "paid", metadata: { ...metadata, name: "Pro" } },
    null,
  );
  const teamMonth = await prices.insertLinked({
    planId: team.id,
    paddlePriceId: "pri_month",
    env: "sandbox",
    snapshot: priceSnapshot("month", "1234"),
  });
  const teamYear = await prices.insertLinked({
    planId: team.id,
    paddlePriceId: "pri_year",
    env: "sandbox",
    snapshot: priceSnapshot("year", "12340"),
  });
  const proMonth = await prices.insertLinked({
    planId: pro.id,
    paddlePriceId: "pri_pro_month",
    env: "sandbox",
    snapshot: priceSnapshot("month", "2500"),
  });
  const teamVersion = await versions.createNext(team.id, TERMS, null, 0);
  await versions.setPriceLink(teamVersion.id, "month", teamMonth.id, null);
  await versions.setPriceLink(teamVersion.id, "year", teamYear.id, null);
  const proVersion = await versions.createNext(
    pro.id,
    { ...TERMS, monthlyAmountMinor: 2500, yearlyAmountMinor: null },
    null,
    0,
  );
  await versions.setPriceLink(proVersion.id, "month", proMonth.id, null);

  const logs: string[] = [];
  const logger: WebhookLogger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };
  let secret: string | undefined = WEBHOOK_SECRET;
  let nowMs = NOW.getTime();
  // The handler's connection can be made to fail on one kind of statement against one table, to prove that nothing stays half applied.
  let failure: { kind: string; table: string } | undefined;
  const failing: KyselyPlugin = {
    transformQuery(args) {
      const query = describeQuery(args.node);
      if (
        failure !== undefined &&
        query.kind === failure.kind &&
        query.table === failure.table
      )
        throw new Error("injected database failure");
      return args.node;
    },
    transformResult: async (args) => args.result,
  };
  const deps: BillingWebhookDeps = {
    db: db.withPlugin(failing),
    config: async () =>
      secret === undefined
        ? undefined
        : { secret, environment: options.environment ?? "sandbox" },
    now: () => new Date(nowMs),
    logger,
    ...(options.toleranceSeconds === undefined
      ? {}
      : { toleranceSeconds: options.toleranceSeconds }),
    ...(options.maxBodyBytes === undefined
      ? {}
      : { maxBodyBytes: options.maxBodyBytes }),
  };
  const handler = createBillingWebhookHandler(deps);

  /** The signed requests Paddle would send for these events. */
  function requests(events: PaddleEvent[], send: SendOptions = {}): Request[] {
    return buildDeliveries(events, {
      secret: send.secret ?? WEBHOOK_SECRET,
      now: () => send.signedAt ?? nowMs,
      ...(send.fault === undefined ? {} : { fault: send.fault }),
      ...(send.staleSeconds === undefined
        ? {}
        : { staleSeconds: send.staleSeconds }),
      ...(send.order === undefined ? {} : { order: send.order }),
      ...(send.duplicates === undefined ? {} : { duplicates: send.duplicates }),
    }).map(
      (delivery) =>
        new Request(WEBHOOK_URL, {
          method: "POST",
          headers: delivery.headers,
          body: delivery.body,
        }),
    );
  }

  /** Delivers the events one after the other and answers the statuses. */
  async function deliver(
    events: PaddleEvent[],
    send: SendOptions = {},
  ): Promise<Response[]> {
    const answers: Response[] = [];
    for (const request of requests(events, send))
      answers.push(await handler(request));
    return answers;
  }

  async function deliverOne(
    one: PaddleEvent,
    send: SendOptions = {},
  ): Promise<Response> {
    const [answer] = await deliver([one], send);
    if (answer === undefined) throw new Error("no answer");
    return answer;
  }

  /** A checkout row of the server, as #443 will write it. */
  function checkout(
    workspaceId: string,
    transactionId: string,
    interval: "month" | "year" = "month",
    versionId: string = teamVersion.id,
  ) {
    return createBillingCheckoutsRepository(db, workspaceId).create({
      env: "sandbox",
      transactionId,
      planVersionId: versionId,
      billingInterval: interval,
    });
  }

  const subscriptionsOf = (workspaceId: string) =>
    createBillingSubscriptionsRepository(db, workspaceId);

  /** Every row of the four billing tables of this change, as strings, for "nothing personal is stored" checks. */
  async function dump(): Promise<string> {
    const tables = [
      "billing_customers",
      "billing_subscriptions",
      "billing_checkouts",
      "billing_webhook_events",
    ] as const;
    const rows = await Promise.all(
      tables.map((table) => db.selectFrom(table).selectAll().execute()),
    );
    return JSON.stringify(rows);
  }

  return {
    db,
    workspaceA,
    workspaceB,
    team,
    pro,
    teamVersion,
    proVersion,
    teamMonth,
    teamYear,
    proMonth,
    prices,
    versions,
    logs,
    handler,
    requests,
    deliver,
    deliverOne,
    checkout,
    subscriptionsOf,
    dump,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setSecret: (value: string | undefined) => {
      secret = value;
    },
    /** From now on the handler's `kind` statements (`insert`, `update`) against `table` fail, until `heal()`. */
    failOn: (kind: string, table: string) => {
      failure = { kind, table };
    },
    heal: () => {
      failure = undefined;
    },
  };
}
export type WebhookHarness = Awaited<ReturnType<typeof startWebhookHarness>>;
