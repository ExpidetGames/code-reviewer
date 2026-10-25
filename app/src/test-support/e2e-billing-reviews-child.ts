// SPDX-License-Identifier: LicenseRef-Proprietary

// A program the Playwright journey of the billing review rows runs (node runs this file directly, TypeScript types are stripped;
// `--conditions=react-server` lets `server-only` pass) to leave two review rows in the app under test the way the webhook does:
// through the real repositories on the app's SQLite file, never by writing rows. The app is a separate process with the same
// file open (WAL), so the rows show up in its pages.
//
//   seed <db>   -> {workspaceId}
//
// A top-up of 25 USD of the default workspace with a payment that was refused (an amount that does not fit), and a refund of a
// payment that belongs to nobody here. Prints one JSON line.
import { openDatabase } from "../db/connection.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import { createBillingWebhookEventsRepository } from "../db/repositories/billing-webhook-events-repository.ts";

const [command, databasePath] = process.argv.slice(2);
if (command !== "seed" || !databasePath)
  throw new Error("Usage: e2e-billing-reviews-child.ts seed <db>");

const db = openDatabase({
  driver: "sqlite",
  path: databasePath,
  busyTimeoutMs: 5000,
});
try {
  const workspace = await db
    .selectFrom("workspaces")
    .select("id")
    .where("slug", "=", "default")
    .executeTakeFirstOrThrow();
  await createBillingTopUpIntentsRepository(db, workspace.id).create({
    id: "e2e-intent-1",
    adapter: "stripe",
    amountMicroUsd: 25_000_000,
  });
  const events = createBillingWebhookEventsRepository(db);
  await events.claim("stripe", "evt_e2e_foreign", "2026-10-21T08:00:00.000Z");
  await events.finish(
    "stripe",
    "evt_e2e_foreign",
    "intent_unresolved",
    { subject: "refund:re_e2e_foreign", occurredAt: null },
    true,
  );
  await events.claim("stripe", "evt_e2e_refused", "2026-10-21T09:00:00.000Z");
  await events.finish(
    "stripe",
    "evt_e2e_refused",
    "amount_rejected",
    { subject: "payment:pi_e2e_refused", occurredAt: null },
    true,
    { workspaceId: workspace.id, intentId: "e2e-intent-1" },
  );
  console.log(JSON.stringify({ workspaceId: workspace.id }));
} finally {
  await db.destroy();
}
