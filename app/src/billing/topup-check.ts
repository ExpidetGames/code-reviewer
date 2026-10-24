// SPDX-License-Identifier: LicenseRef-Proprietary

// "Check payment" (ADR 0006, 2.13; #502): the user-triggered repair of a lost webhook and the reliable success page. The person
// asks, the adapter asks the payment provider what became of THIS top-up (the one outbound call of the feature, made in a user's
// request and never in the webhook), and the answer, a normalized payment event, goes through the same `applyBillingEvent` as a
// webhook's. Whoever tells first credits; the others are repeats (the journal key is the payment). The order, each step ends the
// request on failure:
//
//   1. role       an Owner or an Admin (`manage_billing`)                                           forbidden
//   2. intent     one of THIS workspace and of the active adapter; any other id, also one of another workspace, is the same
//                 answer                                                                    intent_not_found
//   3. settled    a paid intent is not asked about again: the answer is its state, no call is made
//   4. ask        the adapter looks the top-up up from the checkout the app recorded on the intent; an intent that never got a
//                 page has nothing to ask about, and a provider that no longer knows the object is nothing to report
//   5. apply      the event goes through `applyBillingEvent` (idempotent per event id and per payment)
//
// The answer is the state of the intent afterwards and nothing of the provider. The log gets the workspace id and a result
// code, never an amount, an id of the provider or a person.
import "server-only";
import type { Kysely } from "kysely";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import type { Database } from "../db/schema.ts";
import { can } from "../workspaces/permissions.ts";
import { BillingAdapterError, type BillingAdapter } from "./adapter.ts";
import { applyBillingEvent } from "./apply-event.ts";
import type { BillingActor } from "./profile-service.ts";
import type { TopUpIntentState } from "./topup-intent.ts";

export const TOP_UP_CHECK_ERROR_CODES = [
  "forbidden",
  "intent_not_found",
  "provider_unavailable",
  "provider_rejected",
  "provider_not_configured",
] as const;
export type TopUpCheckErrorCode = (typeof TOP_UP_CHECK_ERROR_CODES)[number];

export type TopUpCheckResult =
  | { ok: true; intentId: string; state: TopUpIntentState }
  | { ok: false; error: TopUpCheckErrorCode };

export type TopUpCheckService = {
  check(actor: BillingActor, intentId: string): Promise<TopUpCheckResult>;
};

const ADAPTER_ERROR_TO_CODE: Partial<
  Record<BillingAdapterError["code"], TopUpCheckErrorCode>
> = {
  provider_unavailable: "provider_unavailable",
  request_in_progress: "provider_unavailable",
  provider_not_configured: "provider_not_configured",
};

export function createTopUpCheckService({
  db,
  adapter,
  now,
  log = (line) => console.info(line),
}: {
  db: Kysely<Database>;
  /** The adapter billing runs on; one without `lookupTopUp` is not asked (the route answers the missing path first). */
  adapter: BillingAdapter;
  now?: () => Date;
  log?: (line: string) => void;
}): TopUpCheckService {
  return {
    async check(actor, intentId) {
      const done = (result: TopUpCheckResult): TopUpCheckResult => {
        log(
          `[billing] TOPUP_CHECKED workspace=${actor.workspaceId} result=${result.ok ? result.state : result.error}`,
        );
        return result;
      };
      if (!can(actor.role, "manage_billing"))
        return done({ ok: false, error: "forbidden" });

      const intents = createBillingTopUpIntentsRepository(
        db,
        actor.workspaceId,
        now,
      );
      const intent = await intents.get(intentId);
      if (
        intent === undefined ||
        intent.adapter !== adapter.id ||
        adapter.lookupTopUp === undefined
      )
        return done({ ok: false, error: "intent_not_found" });
      const stateOf = (state: TopUpIntentState): TopUpCheckResult => ({
        ok: true,
        intentId: intent.id,
        state,
      });
      // A paid intent has nothing left to learn; nothing else can end it, so no call is made.
      if (intent.state === "paid" || intent.checkoutRef === null)
        return done(stateOf(intent.state));

      try {
        const event = await adapter.lookupTopUp({
          intentId: intent.id,
          checkout: intent.checkoutRef,
          payment: intent.paymentRef,
        });
        if (event === null) return done(stateOf(intent.state));
        await applyBillingEvent(db, {
          provider: adapter.id,
          event,
          ...(now === undefined ? {} : { now }),
        });
      } catch (error) {
        if (error instanceof BillingAdapterError)
          return done({
            ok: false,
            error: ADAPTER_ERROR_TO_CODE[error.code] ?? "provider_rejected",
          });
        log(
          `[billing] TOPUP_CHECKED workspace=${actor.workspaceId} result=unexpected_error`,
        );
        throw error;
      }
      const after = await intents.get(intent.id);
      return done(stateOf(after?.state ?? intent.state));
    },
  };
}
