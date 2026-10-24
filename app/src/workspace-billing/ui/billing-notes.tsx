// SPDX-License-Identifier: LicenseRef-Proprietary

// The two notes at the foot of the billing page (ADR 0006, 2.5, 2.17; #505): whose key reviews run on, with the way to the LLM
// access page where it is chosen, and who issues the invoices. The page promises nothing about VAT-compliant invoices: that waits
// for the sandbox plan of #503.
import Link from "next/link";
import {
  INVOICES_LINK_HREF,
  INVOICES_LINK_TEXT,
  INVOICES_TEXT,
  KEY_HEADING,
  KEY_LINK_TEXT,
  KEY_TEXT,
} from "../messages.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import type { WorkspaceKeyMode } from "../view.ts";

export function BillingNotes({
  workspaceSlug,
  keyMode,
  showInvoices,
}: {
  workspaceSlug: string;
  keyMode: WorkspaceKeyMode;
  /** The provider issues the invoices (the manual adapter has none to speak of). */
  showInvoices: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 text-sm text-muted-foreground">
      <section aria-label={KEY_HEADING} className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">{KEY_HEADING}</h2>
        <p>{KEY_TEXT[keyMode]}</p>
        <p>
          <Link href={workspacePath(workspaceSlug, "/settings/llm")}>
            {KEY_LINK_TEXT}
          </Link>
        </p>
      </section>
      {showInvoices ? (
        <p>
          {INVOICES_TEXT}{" "}
          <a
            href={INVOICES_LINK_HREF}
            target="_blank"
            rel="noopener noreferrer"
          >
            {INVOICES_LINK_TEXT}
          </a>
        </p>
      ) : null}
    </div>
  );
}
