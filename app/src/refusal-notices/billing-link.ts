// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the notice of a refused review leads once billing exists (ADR 0006, 2.5; #505). While billing is on the billing page of
// the workspace is where an Owner or an Admin adds credit or changes the monthly limit, and it takes the place of the plan page,
// so the links lead there: the refusals for the balance and the monthly limit (`settingsUrl`) always, and the link of a quota or a
// suspension (`planPageUrl`) when the instance has one. While billing is off nothing changes: the settings of the workspace for the
// balance (an old notice that is retried), and the plan link exactly as `plan-link.ts` makes it. The base address is the
// configured address of the app, never a request.
import type { PlanPageUrlResolver } from "./plan-link.ts";
import { billingPageUrl, workspaceSettingsUrl } from "./plan-page.ts";

export function createBillingAwareLinks({
  isBillingOn,
  baseUrl,
  plan,
}: {
  isBillingOn: () => Promise<boolean>;
  baseUrl: () => string;
  /** The plan link as it is without billing (`createPlanPageUrlResolver`). */
  plan: PlanPageUrlResolver;
}): { planPageUrl: PlanPageUrlResolver; settingsUrl: PlanPageUrlResolver } {
  return {
    async planPageUrl(workspaceSlug) {
      const link = await plan(workspaceSlug);
      if (link === null) return null;
      return (await isBillingOn())
        ? billingPageUrl(baseUrl(), workspaceSlug)
        : link;
    },
    async settingsUrl(workspaceSlug) {
      return (await isBillingOn())
        ? billingPageUrl(baseUrl(), workspaceSlug)
        : workspaceSettingsUrl(baseUrl(), workspaceSlug);
    },
  };
}
