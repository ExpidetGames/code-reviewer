// SPDX-License-Identifier: LicenseRef-Proprietary

// The hint at the top of the workspace pages while reviews have no LLM access: it replaces the global
// banner about the `LLM_*` variables (docs/decisions/0001-editions-setup-and-accounts.md, section 2.8). Nothing
// at all while a key works. It links to the section where an Admin or an Owner enters the key.
//
// `llmAccessAttention` builds the notice as data, so a page can merge it into its one "Needs attention"
// strip (#173) instead of rendering a second notice region; `LlmAccessNotice` renders it on its own.
import Link from "next/link";
import type { AttentionNotice } from "../../components/needs-attention.tsx";
import { NeedsAttention } from "../../components/needs-attention.tsx";
import { instanceAccessOf } from "../access.ts";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import { workspacePath } from "../../workspaces/paths.ts";

export function llmAccessAttention({
  workspaceSlug,
  summary,
  canManage,
}: {
  workspaceSlug: string;
  summary: WorkspaceLlmSummary;
  canManage: boolean;
}): AttentionNotice | null {
  if (summary.configured) return null;
  // The access comes from the instance, or the instance cannot say whose key applies: the workspace has no
  // form to fix it with, so no link to one.
  if (instanceAccessOf(summary) !== null)
    return {
      id: "llm_access",
      severity: "error",
      title: "LLM is not available",
      detail: (
        <>
          Reviews of this workspace cannot run right now: code-review.com cannot
          set up the LLM at the moment. Contact the administrator.
        </>
      ),
    };
  const unreadable = summary.reason === "key_unreadable";
  const settingsPath = workspacePath(workspaceSlug, "/settings/llm");
  return {
    id: "llm_access",
    severity: "error",
    title: unreadable
      ? "The saved LLM key cannot be read"
      : "LLM not configured",
    detail: (
      <>
        Reviews of this workspace cannot run until it has an LLM key.{" "}
        {canManage ? (
          <Link href={settingsPath}>Add a key in the settings</Link>
        ) : (
          <>
            Ask an Admin or an Owner of this workspace to add one in the{" "}
            <Link href={settingsPath}>settings</Link>.
          </>
        )}
      </>
    ),
  };
}

export function LlmAccessNotice(props: {
  workspaceSlug: string;
  summary: WorkspaceLlmSummary;
  canManage: boolean;
}) {
  const notice = llmAccessAttention(props);
  return <NeedsAttention notices={notice === null ? [] : [notice]} />;
}
