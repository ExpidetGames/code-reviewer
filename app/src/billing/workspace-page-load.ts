// SPDX-License-Identifier: Apache-2.0

// What the page file of the billing page asks for (ADR 0006, 2.5; #505), apart from Next.js: while billing is off the page does not
// exist (the 404 of a path that does not exist, nothing is read); while it is on, the data of the person's workspace and what the
// payment page said on the way back (`?topup=success` or `?topup=cancelled`). The page file only wires the real collaborators in.
import "server-only";
import type { WorkspaceBillingView } from "../workspace-billing/view.ts";
import type { BillingActor } from "./profile-service.ts";
import type { WorkspaceBillingService } from "./workspace-page.ts";

export type TopUpReturn = "success" | "cancelled";

/** The state the payment page sent the person back with; anything else (or a repeated parameter) is none. */
export function returnedOf(
  value: string | string[] | undefined,
): TopUpReturn | null {
  return value === "success" || value === "cancelled" ? value : null;
}

export type BillingPageLoad =
  | { kind: "not_found" }
  | { kind: "ok"; view: WorkspaceBillingView; returned: TopUpReturn | null };

export async function loadWorkspaceBillingPage({
  isOn,
  service,
  actor,
  topup,
}: {
  isOn: () => Promise<boolean>;
  service: Pick<WorkspaceBillingService, "overview">;
  actor: BillingActor;
  topup: string | string[] | undefined;
}): Promise<BillingPageLoad> {
  if (!(await isOn())) return { kind: "not_found" };
  const result = await service.overview(actor);
  if (!result.ok) return { kind: "not_found" };
  return { kind: "ok", view: result.view, returned: returnedOf(topup) };
}
