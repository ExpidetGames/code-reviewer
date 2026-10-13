// SPDX-License-Identifier: Apache-2.0

// The "LLM access" sub-page of the workspace settings (#178): one card with the write-only key form
// (an Admin or an Owner) or whether reviews have a key (a Member). The intro and the storage claim are
// behind one disclosure; the removal of the key is a destructive action and lives in "Advanced"
// (`remove-workspace-key.tsx`). The model is not set here: it is the `model` of the review defaults,
// whose built-in value is the instance's default model (`LLM_MODEL`).
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import type { WorkspaceLlmKeyStatus } from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";
import { LlmAccessForm } from "./llm-access-form.tsx";

function SourceNote({ summary }: { summary: WorkspaceLlmSummary }) {
  if (!summary.configured) return null;
  if (summary.source === "workspace") return null;
  return (
    <p className="text-sm text-muted-foreground">
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
    <Card role="region" aria-labelledby="llm-key-heading">
      <CardHeader>
        <CardTitle>
          <h2
            id="llm-key-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Key
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <HelpDisclosure label="How the key is stored">
          Reviews run with the API key of this workspace, and the provider bills
          that account. The key is stored encrypted on this server and is never
          shown again. The operator of this instance holds the key that encrypts
          it and can technically decrypt it.
        </HelpDisclosure>
        <SourceNote summary={summary} />
        {canManage ? (
          <LlmAccessForm
            // Not keyed on the status: the page's data changes after a save (`router.refresh()`),
            // and a form that is mounted again would lose the message that says it worked. It shows
            // the status it gets.
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
      </CardContent>
    </Card>
  );
}
