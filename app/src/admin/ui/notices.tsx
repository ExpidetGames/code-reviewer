// SPDX-License-Identifier: Apache-2.0

// The notices of the portal. The warning of a rule that cannot work yet comes from the shared rule
// copy (#169), so the wizard and the portal say the same thing, and it has one owner that both the
// overview (#180) and the Setup → Sign-up page (#181) render through the shared `NeedsAttention`
// component: one entry point, one wording.

import Link from "next/link";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import type { AttentionNotice } from "../../components/needs-attention.tsx";
import { FAIL_CLOSED_WARNING } from "../../signup/ui/rule-copy.ts";

export const FAIL_CLOSED_TITLE = "This sign-up rule does not work yet.";
const FAIL_CLOSED_INVITATIONS =
  "No invitation can be created either. Accounts that exist are not affected.";

/** The sign-up rule names emails or domains and nothing can verify an address yet (ADR section 2.5). */
export function failClosedAttention(): AttentionNotice {
  return {
    id: "sign-up-rule-fail-closed",
    severity: "warning",
    title: FAIL_CLOSED_TITLE,
    detail: (
      <>
        {FAIL_CLOSED_WARNING} Configure it under{" "}
        <Link href="/admin/mail">Mail</Link> or make GitHub the only way to sign
        in under <Link href="/admin/setup/sign-in">Sign-in</Link>.{" "}
        <HelpDisclosure label="What this means">
          {FAIL_CLOSED_INVITATIONS}
        </HelpDisclosure>
      </>
    ),
  };
}
