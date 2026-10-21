// SPDX-License-Identifier: Apache-2.0

// What the page file of the billing page asks for (ADR 0006, 2.5; #505), apart from Next.js: while billing is off the page does not
// exist (the 404 of a path that does not exist, nothing is read); while it is on, the data of the person's workspace and what the
// payment page said on the way back (`?topup=success` or `?topup=cancelled`). The page file only wires the real collaborators in.
import "server-only";
import type { WorkspaceBillingView } from "../workspace-billing/view.ts";
import type { LegalUrls } from "./legal-urls.ts";
import type { BillingActor } from "./profile-service.ts";
import type { WorkspaceBillingService } from "./workspace-page.ts";

export type TopUpReturn = "success" | "cancelled";

/** The state the payment page sent the person back with; anything else (or a repeated parameter) is none. */
export function returnedOf(
  value: string | string[] | undefined,
): TopUpReturn | null {
  return value === "success" || value === "cancelled" ? value : null;
}

/** The links the business confirmation shows (#626); null for one the instance has not set. */
export type LegalLinks = { termsUrl: string | null; privacyUrl: string | null };

export type BillingPageLoad =
  | { kind: "not_found" }
  | {
      kind: "ok";
      view: WorkspaceBillingView;
      returned: TopUpReturn | null;
      legal: LegalLinks;
    };

export async function loadWorkspaceBillingPage({
  isOn,
  service,
  legal,
  actor,
  topup,
}: {
  isOn: () => Promise<boolean>;
  service: Pick<WorkspaceBillingService, "overview">;
  /** The links of the operator's terms and privacy statement; read only while billing is on. */
  legal: () => Promise<LegalUrls | undefined>;
  actor: BillingActor;
  topup: string | string[] | undefined;
}): Promise<BillingPageLoad> {
  if (!(await isOn())) return { kind: "not_found" };
  const result = await service.overview(actor);
  if (!result.ok) return { kind: "not_found" };
  const links = await legal();
  return {
    kind: "ok",
    view: result.view,
    returned: returnedOf(topup),
    legal: {
      termsUrl: links?.termsUrl ?? null,
      privacyUrl: links?.privacyUrl ?? null,
    },
  };
}
