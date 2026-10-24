// SPDX-License-Identifier: Apache-2.0

"use client";
// The sub-navigation of the workspace settings (#178): one link per sub-page, the current one carries `aria-current="page"`,
// which the styling turns into an underline as well, so the location is never shown by colour alone.
//
// "Advanced" (#658) only holds the deletion of the workspace and is the Owner's alone, so only an Owner sees the link. The
// settings layout (`app/(app)/w/[workspace]/settings/layout.tsx`) knows the role and hands it down through
// `SettingsAccessProvider`, so no page has to pass it on; the nav takes it from there unless a caller says it itself. It is a
// promise, read with `use` behind the nav's own <Suspense> boundary: the nav shows without the link until the role is known, and
// the page below stays outside any boundary of the layout, so a page that answers "not found" still answers with status 404.
import { PILL_LINK_CLASS } from "@/components/pill-link";
import Link from "next/link";
import {
  createContext,
  Suspense,
  use,
  useContext,
  type ReactNode,
} from "react";
import {
  SETTINGS_SECTIONS,
  settingsSectionHref,
  type SettingsSection,
} from "./settings-sections.ts";

const SettingsAccessContext = createContext<Promise<boolean> | null>(null);

/** Tells every settings navigation below it whether the person may see "Advanced" (the Owner); the answer may still be coming. */
export function SettingsAccessProvider({
  showAdvanced,
  children,
}: {
  showAdvanced: Promise<boolean>;
  children: ReactNode;
}) {
  return (
    <SettingsAccessContext.Provider value={showAdvanced}>
      {children}
    </SettingsAccessContext.Provider>
  );
}

type SettingsNavProps = {
  workspaceSlug: string;
  current: SettingsSection;
  /** The workspace has entitlements (#282): the Plan page is listed. An unlimited workspace has no entry. */
  showPlan?: boolean;
  /** Billing is on (#505): the Billing page is listed, and the Plan page is not (the Billing page takes its place). */
  showBilling?: boolean;
  /** The Advanced page is listed. Left out, the settings layout decides (the Owner sees it). */
  showAdvanced?: boolean;
};

export function SettingsNav(props: SettingsNavProps) {
  return (
    <Suspense fallback={<SettingsLinks {...props} advanced={false} />}>
      <SettingsNavWithAccess {...props} />
    </Suspense>
  );
}

function SettingsNavWithAccess(props: SettingsNavProps) {
  const access = useContext(SettingsAccessContext);
  const advanced =
    props.showAdvanced ?? (access === null ? false : use(access));
  return <SettingsLinks {...props} advanced={advanced} />;
}

function SettingsLinks({
  workspaceSlug,
  current,
  showPlan = false,
  showBilling = false,
  advanced,
}: SettingsNavProps & { advanced: boolean }) {
  return (
    <nav aria-label="Settings sections">
      <ul className="flex flex-wrap items-center gap-1">
        {SETTINGS_SECTIONS.filter((section) => {
          if (section.segment === "plan") return showPlan && !showBilling;
          if (section.segment === "billing") return showBilling;
          if (section.segment === "advanced") return advanced;
          return true;
        }).map((section) => {
          const active = section.segment === current;
          return (
            <li key={section.segment || "general"}>
              <Link
                href={settingsSectionHref(workspaceSlug, section.segment)}
                aria-current={active ? "page" : undefined}
                className={PILL_LINK_CLASS}
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
