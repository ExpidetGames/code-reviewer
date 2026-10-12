// SPDX-License-Identifier: Apache-2.0

// The hint at the top of the workspace pages while reviews have no LLM access: it replaces the global
// banner about the `LLM_*` variables (docs/decisions/0001-editions-setup-and-accounts.md, section 2.8). Nothing
// at all while a key works. It links to the section where an Admin or an Owner enters the key.
import Link from "next/link";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import { workspacePath } from "../../workspaces/paths.ts";
import { LLM_ACCESS_SECTION_ID } from "./llm-access-section.tsx";

export function LlmAccessNotice({
  workspaceSlug,
  summary,
  canManage,
}: {
  workspaceSlug: string;
  summary: WorkspaceLlmSummary;
  canManage: boolean;
}) {
  if (summary.configured) return null;
  const unreadable = summary.reason === "key_unreadable";
  return (
    <section className="notices" aria-label="LLM access">
      <div className="alert alert-error" role="alert">
        <strong>
          {unreadable
            ? "The saved LLM key cannot be read"
            : "LLM not configured"}
        </strong>
        <p>
          Reviews of this workspace cannot run until it has an LLM key.{" "}
          {canManage ? (
            <Link
              href={`${workspacePath(workspaceSlug, "/settings")}#${LLM_ACCESS_SECTION_ID}`}
            >
              Add a key in the settings
            </Link>
          ) : (
            <>
              Ask an Admin or an Owner of this workspace to add one in the{" "}
              <Link
                href={`${workspacePath(workspaceSlug, "/settings")}#${LLM_ACCESS_SECTION_ID}`}
              >
                settings
              </Link>
              .
            </>
          )}
        </p>
      </div>
    </section>
  );
}
