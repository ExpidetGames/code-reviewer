// SPDX-License-Identifier: Apache-2.0

// The wiring of the billing routes: the real database, the adapters this instance has and the switch. This is the one place
// that decides which adapters exist; the Stripe adapter joins the list with #501 and #502. It also holds the services of
// the billing page of the admin portal (#504) and the billing measures of the running server (#493): what the queue reports
// when a claim ended, handed to the platform to run after the response like every other reaction (src/dispatch/shared.ts).
import "server-only";
import { notFound } from "next/navigation";
import { loadAuthConfig } from "../auth/config.ts";
import { getDatabase } from "../db/startup.ts";
import { runAfterResponse } from "../dispatch/shared.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { getSecretStore, getSecretStoreOn } from "../secrets/shared.ts";
import { createAdapterRegistry } from "./adapter.ts";
import {
  createBillingCreditService,
  type BillingCreditService,
} from "./admin-credit-service.ts";
import {
  createBillingReviewService,
  type BillingReviewService,
} from "./admin-review-service.ts";
import {
  createBillingAdminService,
  type BillingAdminService,
} from "./admin-service.ts";
import { createStripeAdapter } from "./stripe-adapter.ts";
import {
  stripeClientFromSecrets,
  stripeEnvironmentFromSecrets,
  stripeWebhookSecretFromSecrets,
} from "./stripe-credentials.ts";
import { createStripeClient } from "./stripe-client.ts";
import { stripeApiBaseUrl } from "../stripe-endpoints.ts";
import { createActiveAdapterResolver } from "./active-adapter.ts";
import { isBillingOn } from "./enabled.ts";
import { manualAdapter } from "./manual-adapter.ts";
import {
  createMonthlyLimitRoute,
  type MonthlyLimitRoute,
} from "./monthly-limit-http.ts";
import { createMonthlyLimitService } from "./monthly-limit-service.ts";
import { createJournalRoute, type JournalRoute } from "./journal-http.ts";
import { createProfileRoute, type ProfileRoute } from "./profile-http.ts";
import { createBillingProfileService } from "./profile-service.ts";
import { workspaceKeyModeOf } from "./workspace-key-mode.ts";
import {
  createWorkspaceBillingService,
  type WorkspaceBillingService,
} from "./workspace-page.ts";
import { getWorkspaceLlm } from "../llm/shared.ts";
import type { BalanceBannerView } from "../workspace-billing/banner.ts";
import type { WorkspaceRole } from "../workspaces/roles.ts";
import { createCheckPaymentLimits, createTopUpLimits } from "./topup-limits.ts";
import { createTopUpCheckService } from "./topup-check.ts";
import {
  createTopUpCheckRoute,
  type TopUpCheckRoute,
} from "./topup-check-http.ts";
import { createTopUpRoute, type TopUpRoute } from "./topup-http.ts";
import { createTopUpService } from "./topup-service.ts";
import { getMailSender } from "../mail/shared.ts";
import { loadBalanceBanner } from "./balance-banner.ts";
import { deliverDueBalanceMails } from "./balance-mail.ts";
import { createWallClockRecorder } from "./wall-clock.ts";
import { createBillingWebhookHandler } from "./webhook-handler.ts";

/** The configured public address of the app (`BETTER_AUTH_URL`): the one place billing reads the environment. */
function publicAddress(): string {
  return loadAuthConfig(process.env).baseUrl;
}

/**
 * The adapters of this instance: the `manual` one, and Stripe, which reads its key and its webhook secret from the secret store
 * when a top-up, a webhook or a check needs them (never at startup).
 */
export function getBillingAdapterRegistry() {
  return createAdapterRegistry([
    manualAdapter,
    createStripeAdapter({
      client: stripeClientFromSecrets({
        secrets: getSecretStore,
        baseUrl: stripeApiBaseUrl(),
      }),
      webhookSecret: stripeWebhookSecretFromSecrets({
        secrets: getSecretStore,
      }),
      environment: stripeEnvironmentFromSecrets({ secrets: getSecretStore }),
    }),
  ]);
}

/**
 * The handler of `POST /api/w/:workspace/billing/top-ups`, wired to the running server. The page the buyer returns to is built
 * from the configured address of the app (`BETTER_AUTH_URL`), never from a request header.
 */
export function getTopUpRoute(): TopUpRoute {
  const db = getDatabase();
  return createTopUpRoute({
    guard: { isOn: () => isBillingOn(db), notFound },
    activeAdapter: createActiveAdapterResolver(db, getBillingAdapterRegistry()),
    serviceFor: (adapter) => createTopUpService({ db, adapter }),
    limits: createTopUpLimits(createRateLimitsRepository(db)),
    baseUrl: publicAddress(),
    log: console,
  });
}

/** The handlers of `GET` and `PUT /api/w/:workspace/billing/monthly-limit`, wired to the running server. */
export function getMonthlyLimitRoute(): MonthlyLimitRoute {
  const db = getDatabase();
  return createMonthlyLimitRoute({
    guard: { isOn: () => isBillingOn(db), notFound },
    service: createMonthlyLimitService({ db }),
  });
}

/**
 * Whether the settings navigation of a workspace lists the Billing page: billing is on (#505). The switch is the one instance
 * setting; with billing off nothing else is read.
 */
export function billingPageLinkedFor(): Promise<boolean> {
  return isBillingOn(getDatabase());
}

/**
 * The balance banner of the pages of a workspace (#506): for an Owner and an Admin while billing is on and the balance is low, zero
 * or below zero, else null. A database that cannot answer must not break every page of the workspace, so it is no banner.
 */
export async function balanceBannerFor(
  workspace: { id: string; slug: string },
  role: WorkspaceRole,
): Promise<BalanceBannerView | null> {
  try {
    return await loadBalanceBanner({ db: getDatabase(), workspace, role });
  } catch {
    console.error("[billing] BALANCE_BANNER_UNAVAILABLE");
    return null;
  }
}

/** The data of the billing page of a workspace (#505), wired to the running server. */
export function getWorkspaceBillingService(): WorkspaceBillingService {
  const db = getDatabase();
  const activeAdapter = createActiveAdapterResolver(
    db,
    getBillingAdapterRegistry(),
  );
  return createWorkspaceBillingService({
    db,
    activeAdapter,
    keyMode: async (workspaceId) =>
      workspaceKeyModeOf(await getWorkspaceLlm().summaryFor(workspaceId)),
  });
}

/** The handler of `GET /api/w/:workspace/billing/journal`, wired to the running server. */
export function getJournalRoute(): JournalRoute {
  const db = getDatabase();
  return createJournalRoute({
    guard: { isOn: () => isBillingOn(db), notFound },
    service: getWorkspaceBillingService(),
  });
}

/** The handlers of `GET` and `PUT /api/w/:workspace/billing/profile`, wired to the running server. */
export function getProfileRoute(): ProfileRoute {
  const db = getDatabase();
  return createProfileRoute({
    guard: { isOn: () => isBillingOn(db), notFound },
    service: createBillingProfileService({ db }),
  });
}

/** The handler of `POST /api/w/:workspace/billing/top-ups/:id/check` ("Check payment"), wired to the running server. */
export function getTopUpCheckRoute(): TopUpCheckRoute {
  const db = getDatabase();
  return createTopUpCheckRoute({
    guard: { isOn: () => isBillingOn(db), notFound },
    activeAdapter: createActiveAdapterResolver(db, getBillingAdapterRegistry()),
    serviceFor: (adapter) => createTopUpCheckService({ db, adapter }),
    limits: createCheckPaymentLimits(createRateLimitsRepository(db)),
    log: console,
  });
}

/** The handler of `POST /api/billing/webhook`, wired to the running server. */
export function getBillingWebhookHandler(): (
  request: Request,
) => Promise<Response> {
  const db = getDatabase();
  return createBillingWebhookHandler({
    db,
    guard: { isOn: () => isBillingOn(db), notFound },
    activeAdapter: createActiveAdapterResolver(db, getBillingAdapterRegistry()),
    afterApplied: deliverBalanceMails,
  });
}

/**
 * The billing settings of the admin portal on the running server (#504). The public address is the configured one
 * (`BETTER_AUTH_URL`), never a request header, and the Stripe address is Stripe's own: there is no setting for it, because the API key goes there. Nothing is
 * called until the admin presses a button.
 */
export function getBillingAdminService(): BillingAdminService {
  return createBillingAdminService({
    db: getDatabase(),
    secretsOn: getSecretStoreOn,
    publicUrl: publicAddress(),
    clientFor: (apiKey, environment) =>
      createStripeClient({
        apiKey,
        baseUrl: stripeApiBaseUrl(),
        environment,
      }),
  });
}

/** The manual credit of the admin portal on the running server (#504). */
export function getBillingCreditService(): BillingCreditService {
  return createBillingCreditService({ db: getDatabase() });
}

/**
 * The billing review rows of the admin portal on the running server (#603). "Check payment" over the adapter billing runs on is
 * the one a workspace owner makes (`getTopUpCheckRoute`), asked for by the instance admin.
 */
export function getBillingReviewService(): BillingReviewService {
  const db = getDatabase();
  const activeAdapter = createActiveAdapterResolver(
    db,
    getBillingAdapterRegistry(),
  );
  return createBillingReviewService({
    db,
    credit: getBillingCreditService(),
    check: {
      adapter: activeAdapter,
      serviceFor: (adapter) => createTopUpCheckService({ db, adapter }),
    },
  });
}

/**
 * How many billing review rows are open, for the badge of the admin menu and the line of the overview (#603). A database that
 * cannot answer must not break every page of the portal, so it counts as none (the list itself says what is wrong).
 */
export async function countOpenBillingReviews(): Promise<number> {
  try {
    return await getBillingReviewService().openCount();
  } catch {
    console.error("[billing] BILLING_REVIEW_COUNT_UNAVAILABLE");
    return 0;
  }
}

/** The claims of these jobs ended: records the wall clock of those that ran on a runner, where billing is on. Never throws, never delays the call. */
export function recordWallClocks(jobIds: readonly string[]): void {
  if (jobIds.length === 0) return;
  try {
    const recorder = createWallClockRecorder({ db: getDatabase() });
    runAfterResponse(() => recorder.recordFor(jobIds));
  } catch {
    console.error("[billing] WALL_CLOCK_NOT_RECORDED");
  }
}

/**
 * Mails the balance crossings that are due (#506), after the response and best effort: the decision was made in the transaction
 * that moved the balance, so this only sends. Called when claims ended, when a claim was refused for the balance and when a
 * billing webhook was applied; a call that finds nothing due does one small read. Never throws, never delays the call, and
 * logs only a stable code.
 */
export function deliverBalanceMails(): void {
  runAfterResponse(async () => {
    try {
      await deliverDueBalanceMails({
        db: getDatabase(),
        mail: getMailSender(),
        baseUrl: publicAddress(),
      });
    } catch {
      console.error("[billing] BALANCE_MAIL_FAILED code=unavailable");
    }
  });
}
