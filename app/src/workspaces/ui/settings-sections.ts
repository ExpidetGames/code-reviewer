// SPDX-License-Identifier: LicenseRef-Proprietary

// The sub-pages of the workspace settings: one source for the links of the navigation and the headings of the pages.
import type { Capability } from "../../capabilities/capability.ts";
import { PLAN_NAV_LABEL, PLAN_PAGE_TITLE } from "../../copy/plan-usage.ts";
import { workspacePath } from "../paths.ts";
import {
  BILLING_NAV_LABEL,
  BILLING_PAGE_TITLE,
} from "../../workspace-billing/messages.ts";

export const SETTINGS_SECTIONS: readonly {
  segment: SettingsSection;
  label: string;
  title: string;
  /** Listed only in a deployment that has this capability (src/capabilities/). */
  capability?: Capability;
}[] = [
  { segment: "", label: "General", title: "General" },
  {
    segment: "review-defaults",
    label: "Review defaults",
    title: "Review defaults",
    capability: "review",
  },
  { segment: "llm", label: "LLM", title: "LLM" },
  // Only listed while the workspace has entitlements (`showPlan`); the page itself exists for everybody.
  { segment: "plan", label: PLAN_NAV_LABEL, title: PLAN_PAGE_TITLE },
  // Only listed while billing is on (`showBilling`), and then instead of the Plan page (#505).
  {
    segment: "billing",
    label: BILLING_NAV_LABEL,
    title: BILLING_PAGE_TITLE,
    capability: "billing",
  },
  { segment: "advanced", label: "Advanced", title: "Advanced" },
];

export type SettingsSection =
  "" | "review-defaults" | "llm" | "plan" | "billing" | "advanced";

/** The address of a settings sub-page: the index lives at `/settings`, the others below it. */
export function settingsSectionHref(
  workspaceSlug: string,
  segment: SettingsSection,
): string {
  return workspacePath(
    workspaceSlug,
    segment === "" ? "/settings" : `/settings/${segment}`,
  );
}
