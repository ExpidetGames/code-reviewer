// SPDX-License-Identifier: Apache-2.0

// The "LLM access" section of the workspace settings (docs/decisions/0001-editions-setup-and-accounts.md,
// sections 2.7 and 2.8). An Admin or an Owner (`manage_llm_key`) gets the form; a Member is told whether
// reviews have a key and whom to ask. The model is not set here: it is the `model` of the review settings
// below, whose built-in value is the instance's default model (`LLM_MODEL`, or the recommended one); the
// name of that model is not a secret and every member sees it in that form.
import { LlmAccessForm } from "./llm-access-form.tsx";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { WorkspaceLlmKeyStatus } from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";

export const LLM_ACCESS_SECTION_ID = "llm-access";

function SourceNote({
  summary,
  canManage,
}: {
  summary: WorkspaceLlmSummary;
  canManage: boolean;
}) {
  if (!summary.configured) return null;
  if (summary.source === "workspace") return null;
  if (summary.source === "environment")
    return (
      <p className="muted">
        {canManage
          ? "Reviews of this workspace currently use the key that is set on the server (the LLM_API_KEY variable). A key saved here replaces it for this workspace."
          : "Reviews of this workspace currently use the key that is set on the server."}
      </p>
    );
  return (
    <p className="muted">
      Reviews of this workspace use the key of the operator.
    </p>
  );
}

export function LlmAccessSection({
  workspaceSlug,
  canManage,
  keyStatus,
  summary,
  api,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  keyStatus: WorkspaceLlmKeyStatus;
  summary: WorkspaceLlmSummary;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  return (
    <section
      id={LLM_ACCESS_SECTION_ID}
      className="settings-section"
      aria-labelledby="llm-access-heading"
    >
      <h2 id="llm-access-heading">LLM access</h2>
      <p className="muted">
        Reviews run with the API key of this workspace, and the provider bills
        that account. The key is stored encrypted on this server and is never
        shown again. The operator of this instance holds the key that encrypts
        it and can technically decrypt it.
      </p>
      <SourceNote summary={summary} canManage={canManage} />
      {canManage ? (
        <LlmAccessForm
          key={JSON.stringify(keyStatus)}
          workspaceSlug={workspaceSlug}
          keyStatus={keyStatus}
          {...(api === undefined ? {} : { api })}
        />
      ) : (
        <p>
          {summary.configured
            ? "Reviews of this workspace have an LLM key."
            : keyStatus.state === "unreadable"
              ? "The saved key cannot be read, so reviews cannot run."
              : "No LLM key is set, so reviews cannot run."}{" "}
          Only an Admin or an Owner of the workspace can change it.
        </p>
      )}
    </section>
  );
}
