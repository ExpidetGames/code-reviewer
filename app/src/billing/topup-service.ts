// SPDX-License-Identifier: Apache-2.0

// Starting a top-up (ADR 0006, 2.13; #501): provider-neutral, the same for every adapter that has a checkout. The order is
// the contract; each step ends the request on failure and nothing before the intent touches the provider:
//
//   1. role         an Owner or an Admin (`manage_billing`)                                     forbidden
//   2. amount       a whole number of cents from 1000 to 50000 (10 to 500 USD), inside the range of the adapter
//                                                                        amount_invalid, amount_out_of_range
//   3. intent id    optional, a UUID the top-up form makes once per attempt                        intent_id_invalid
//   4. checkout     the adapter has a checkout page at all                                         checkout_unavailable
//   5. profile      the billing profile exists (adapters that ask for it)                          profile_required
//   6. confirmation the business confirmation, at the first top-up only; stored with the time, the user and the terms
//                   version                                                       business_confirmation_required
//   7. intent       the row that alone maps a payment to a workspace, WRITTEN BEFORE the provider is asked; a repeat with
//                   the same id and amount is the same intent                                      intent_conflict
//   8. customer     the provider's customer is made or brought up to date from the profile and its id is stored
//   9. checkout     the provider's page, asked for with the intent as the idempotency key: the same intent is the same page
//
// A provider that fails leaves no intent pending: it becomes `failed` (a payment that still arrives later can pay it, as for any
// failed intent) and the person tries again with a new one. Nothing is credited here: the balance changes only when the
// provider says the money arrived (#502). The log gets a result code and the workspace id, never a name, an address, a VAT ID,
// an amount, a customer or a page.
import "server-only";
import type { Kysely } from "kysely";
import {
  createBillingProfilesRepository,
  type StoredBillingProfile,
} from "../db/repositories/billing-profiles-repository.ts";
import { createBillingTopUpIntentsRepository } from "../db/repositories/billing-topup-intents-repository.ts";
import type { Database } from "../db/schema.ts";
import { can } from "../workspaces/permissions.ts";
import {
  BillingAdapterError,
  assertTopUpAmount,
  toUsd,
  type BillingAdapter,
  type BillingProfile,
  type Usd,
} from "./adapter.ts";
import { BILLING_TERMS_VERSION } from "./profile.ts";
import type { BillingActor } from "./profile-service.ts";
import type { TopUpIntent } from "./topup-intent.ts";

export const TOP_UP_ERROR_CODES = [
  "forbidden",
  /** The amount is not a whole number of cents: text, a fraction, nothing. */
  "amount_invalid",
  /** The amount is a whole number of cents but outside 10 to 500 USD. */
  "amount_out_of_range",
  "intent_id_invalid",
  /** The adapter has no checkout page (the operator adds credit by hand). */
  "checkout_unavailable",
  "profile_required",
  "business_confirmation_required",
  /** The intent id is taken: by another amount, another workspace, or an intent that is not waiting any more. */
  "intent_conflict",
  "provider_unavailable",
  "provider_rejected",
  "provider_not_configured",
  "vat_id_rejected",
] as const;
export type TopUpErrorCode = (typeof TOP_UP_ERROR_CODES)[number];

export type TopUpResult =
  | { ok: true; intentId: string; url: string }
  | { ok: false; error: TopUpErrorCode };

/** What the top-up form posts, as it arrived: nothing in it is trusted until the steps above have read it. */
export type TopUpRequest = {
  amountCents: unknown;
  confirmBusiness: unknown;
  intentId: unknown;
  /** The workspace's billing page, from the configured address of the app. */
  returnUrl: string;
};

export type TopUpService = {
  start(actor: BillingActor, request: TopUpRequest): Promise<TopUpResult>;
};

const MICRO_USD_PER_CENT = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The UI is English; a language of the interface will decide this when there is one. */
export const BILLING_LOCALE = "en";

const ADAPTER_ERROR_TO_CODE: Partial<
  Record<BillingAdapterError["code"], TopUpErrorCode>
> = {
  provider_unavailable: "provider_unavailable",
  provider_not_configured: "provider_not_configured",
  vat_id_rejected: "vat_id_rejected",
};

export function createTopUpService({
  db,
  adapter,
  now,
  log = (line) => console.info(line),
}: {
  db: Kysely<Database>;
  /** The adapter billing runs on. */
  adapter: BillingAdapter;
  now?: () => Date;
  log?: (line: string) => void;
}): TopUpService {
  return {
    async start(actor, request) {
      const done = (result: TopUpResult): TopUpResult => {
        log(
          `[billing] TOPUP_STARTED workspace=${actor.workspaceId} result=${result.ok ? "ok" : result.error}`,
        );
        return result;
      };
      const refuse = (error: TopUpErrorCode) => done({ ok: false, error });

      if (!can(actor.role, "manage_billing")) return refuse("forbidden");

      const { amountCents } = request;
      if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents))
        return refuse("amount_invalid");
      let amount: Usd;
      try {
        amount = toUsd(amountCents * MICRO_USD_PER_CENT);
        assertTopUpAmount(adapter.capabilities, amount);
      } catch {
        return refuse("amount_out_of_range");
      }

      let chosenId: string | undefined;
      if (request.intentId !== undefined) {
        if (
          typeof request.intentId !== "string" ||
          !UUID.test(request.intentId)
        )
          return refuse("intent_id_invalid");
        chosenId = request.intentId.toLowerCase();
      }

      if (!adapter.capabilities.checkout) return refuse("checkout_unavailable");

      const profiles = createBillingProfilesRepository(
        db,
        actor.workspaceId,
        now,
      );
      let profile = await profiles.get();
      if (profile === undefined && adapter.capabilities.requiresBillingProfile)
        return refuse("profile_required");
      if (profile !== undefined && profile.confirmedAt === null) {
        if (request.confirmBusiness !== true)
          return refuse("business_confirmation_required");
        profile = await profiles.confirmBusiness({
          userId: actor.userId,
          termsVersion: BILLING_TERMS_VERSION,
        });
      }

      const intents = createBillingTopUpIntentsRepository(
        db,
        actor.workspaceId,
        now,
      );
      const waiting = (intent: TopUpIntent) =>
        intent.state === "pending" &&
        intent.adapter === adapter.id &&
        intent.amountMicroUsd === amount;
      let intent: TopUpIntent | undefined;
      if (chosenId === undefined) {
        intent = await intents.create({
          adapter: adapter.id,
          amountMicroUsd: amount,
        });
      } else {
        // The id was chosen by the form: a click twice is the same intent, also when both arrive at once.
        intent = await intents.get(chosenId);
        if (intent === undefined)
          intent = await intents
            .create({
              id: chosenId,
              adapter: adapter.id,
              amountMicroUsd: amount,
            })
            .catch(() => intents.get(chosenId));
        if (intent === undefined || !waiting(intent))
          return refuse("intent_conflict");
      }

      try {
        let customer: string | null = null;
        if (profile !== undefined) {
          const stored =
            profile.customerAdapter === adapter.id ? profile.customerRef : null;
          customer = await adapter.ensureCustomer({
            workspace: { id: actor.workspaceId },
            profile: billingProfileOf(profile),
            customer: stored,
          });
          if (customer !== null && customer !== stored)
            await profiles.setCustomer(adapter.id, customer);
        }
        const started = await adapter.createTopUpCheckout({
          customer,
          intentId: intent.id,
          amount,
          returnUrl: request.returnUrl,
        });
        if (started.checkout.kind !== "redirect") {
          await intents.markFailed(intent.id);
          return refuse("checkout_unavailable");
        }
        if (started.session !== null)
          await intents.attachRefs(intent.id, { checkoutRef: started.session });
        return done({
          ok: true,
          intentId: intent.id,
          url: started.checkout.url,
        });
      } catch (error) {
        // No intent stays pending without a way back, whatever went wrong.
        await intents.markFailed(intent.id).catch(() => undefined);
        if (error instanceof BillingAdapterError)
          return refuse(
            ADAPTER_ERROR_TO_CODE[error.code] ?? "provider_rejected",
          );
        log(
          `[billing] TOPUP_STARTED workspace=${actor.workspaceId} result=unexpected_error`,
        );
        throw error;
      }
    },
  };
}

function billingProfileOf(profile: StoredBillingProfile): BillingProfile {
  return {
    legalName: profile.legalName,
    country: profile.country,
    addressLines:
      profile.addressLine2 === null
        ? [profile.addressLine1]
        : [profile.addressLine1, profile.addressLine2],
    postalCode: profile.postalCode,
    city: profile.city,
    vatId: profile.vatId,
    locale: BILLING_LOCALE,
  };
}
