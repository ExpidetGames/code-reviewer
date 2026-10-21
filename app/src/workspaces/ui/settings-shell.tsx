// SPDX-License-Identifier: Apache-2.0

// The frame of the workspace settings area (#178): the sub-nav with one link per sub-page and the
// shared heading. The settings index ("General", at `/settings`) is the area root and carries no
// breadcrumb; the sub-pages show `Settings / <page>` (epic #165 breadcrumb rule). The current link
// carries `aria-current="page"`, which the styling turns into an underline as well, so the location
// is never shown by colour alone. One source (`SETTINGS_SECTIONS`) feeds the links and the headings.
import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumbs } from "../../components/breadcrumbs.tsx";
import { PLAN_NAV_LABEL, PLAN_PAGE_TITLE } from "../../copy/plan-usage.ts";
import { PageHeader } from "../../components/page-header.tsx";
import { cn } from "../../lib/utils.ts";
import { workspacePath } from "../paths.ts";
import {
  BILLING_NAV_LABEL,
  BILLING_PAGE_TITLE,
} from "../../workspace-billing/messages.ts";

export const SETTINGS_SECTIONS = [
  { segment: "", label: "General", title: "General" },
  {
    segment: "review-defaults",
    label: "Review defaults",
    title: "Review defaults",
  },
  { segment: "llm", label: "LLM access", title: "LLM access" },
  // Only listed while the workspace has entitlements (`showPlan`); the page itself exists for everybody.
  { segment: "plan", label: PLAN_NAV_LABEL, title: PLAN_PAGE_TITLE },
  // Only listed while billing is on (`showBilling`), and then instead of the Plan page (#505).
  { segment: "billing", label: BILLING_NAV_LABEL, title: BILLING_PAGE_TITLE },
  { segment: "advanced", label: "Advanced", title: "Advanced" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["segment"];

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

export function SettingsNav({
  workspaceSlug,
  current,
  showPlan = false,
  showBilling = false,
}: {
  workspaceSlug: string;
  current: SettingsSection;
  /** The workspace has entitlements (#282): the Plan page is listed. An unlimited workspace has no entry. */
  showPlan?: boolean;
  /** Billing is on (#505): the Billing page is listed, and the Plan page is not (the Billing page takes its place). */
  showBilling?: boolean;
}) {
  return (
    <nav aria-label="Settings sections" className="border-b border-border">
      <ul className="flex flex-wrap items-center gap-1">
        {SETTINGS_SECTIONS.filter((section) => {
          if (section.segment === "plan") return showPlan && !showBilling;
          if (section.segment === "billing") return showBilling;
          return true;
        }).map((section) => {
          const active = section.segment === current;
          return (
            <li key={section.segment || "general"}>
              <Link
                href={settingsSectionHref(workspaceSlug, section.segment)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center border-b-2 border-transparent px-3 text-sm font-medium no-underline",
                  "text-muted-foreground hover:text-foreground",
                  "aria-[current=page]:border-primary aria-[current=page]:text-foreground",
                  "pointer-coarse:min-h-11",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * One settings sub-page: the one `h1` of the page, the breadcrumb below the index, the sub-nav and
 * the body. `current` names the section the page is (the sub-nav marks it).
 */
export function SettingsScreen({
  workspaceSlug,
  current,
  showPlan = false,
  showBilling = false,
  children,
}: {
  workspaceSlug: string;
  current: SettingsSection;
  /** The workspace has entitlements (#282), so the sub-nav lists the Plan page. */
  showPlan?: boolean;
  /** Billing is on (#505), so the sub-nav lists the Billing page instead of the Plan page. */
  showBilling?: boolean;
  children: ReactNode;
}) {
  const section = SETTINGS_SECTIONS.find((item) => item.segment === current);
  const title = section?.title ?? "Settings";
  return (
    <>
      <PageHeader
        title={title}
        breadcrumb={
          current === "" ? undefined : (
            <Breadcrumbs
              items={[
                {
                  label: "Settings",
                  href: workspacePath(workspaceSlug, "/settings"),
                },
                { label: title },
              ]}
            />
          )
        }
      />
      <div className="flex flex-col gap-6 pt-6">
        <SettingsNav
          workspaceSlug={workspaceSlug}
          current={current}
          showPlan={showPlan}
          showBilling={showBilling}
        />
        {children}
      </div>
    </>
  );
}
