// SPDX-License-Identifier: Apache-2.0

// The hint "LLM not configured" for the workspace of a page, loaded from the running server. A server
// component for the pages that show the hint; the hint itself is `LlmAccessNotice`.
import "server-only";
import { getWorkspaceLlm } from "../shared.ts";
import { LlmAccessNotice } from "./llm-access-notice.tsx";

export async function WorkspaceLlmNotice({
  workspaceId,
  workspaceSlug,
  canManage,
}: {
  workspaceId: string;
  workspaceSlug: string;
  /** An Admin or an Owner (`manage_llm_key`): they get the link that leads to the key form. */
  canManage: boolean;
}) {
  const summary = await getWorkspaceLlm().summaryFor(workspaceId);
  return (
    <LlmAccessNotice
      workspaceSlug={workspaceSlug}
      summary={summary}
      canManage={canManage}
    />
  );
}
