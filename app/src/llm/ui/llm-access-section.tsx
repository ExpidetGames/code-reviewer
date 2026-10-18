// SPDX-License-Identifier: Apache-2.0

// The "LLM access" sub-page of the workspace settings (#178, #426): one card per registered provider, each
// with the write-only key form of that provider (an Admin or an Owner), or one card with whether reviews have a
// key and the state of each provider's key (a Member). The storage claim is behind a disclosure in every card;
// the removal of a key is a destructive action and lives in "Advanced" (`remove-workspace-key.tsx`). A workspace
// whose access the instance provides gets the note instead of the cards. The model is not set here: it is the
// `model` of the review defaults, whose built-in value is the instance's default model (`LLM_MODEL`).
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { instanceAccessOf } from "../access.ts";
import type { WorkspaceLlmSummary } from "../assemble.ts";
import { llmProviderDescriptors } from "../providers/index.ts";
import type {
  ProviderKeyStatus,
  WorkspaceLlmKeyStatus,
} from "../workspace-key.ts";
import type { LlmKeyApi } from "./api.ts";
import { LlmAccessForm } from "./llm-access-form.tsx";

/**
 * A workspace whose key mode is managed has no key form, whatever its role: the instance provides the access, the
 * workspace's own key (if it has one) is stored and not used, and nothing of it is shown.
 */
function InstanceAccessCard({
  access,
}: {
  access: NonNullable<ReturnType<typeof instanceAccessOf>>;
}) {
  return (
    <Card role="region" aria-labelledby="llm-key-heading">
      <CardHeader>
        <CardTitle>
          <h2
            id="llm-key-heading"
            className="text-lg font-semibold tracking-tight"
          >
            LLM access
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {access === "settings_unreadable" ? (
          <p>
            This instance cannot set up LLM access for this workspace at the
            moment, so reviews cannot run. Contact the administrator of this
            instance.
          </p>
        ) : (
          <>
            <p>LLM access for this workspace is provided by this instance.</p>
            <p className="text-sm text-muted-foreground">
              Reviews do not use a key of this workspace, so there is nothing to
              enter here: this workspace does not use a key of its own.
            </p>
            {access === "key_unavailable" ? (
              <p>
                The access is not available at the moment, so reviews cannot
                run. Contact the administrator of this instance.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const HOW_STORED =
  "Reviews run with the API key of this workspace, and the provider bills that account. The key is stored encrypted on this server and is never shown again. The operator of this instance holds the key that encrypts it and can technically decrypt it.";

const stateOf = (status: WorkspaceLlmKeyStatus) =>
  status.state === "configured"
    ? "a key is saved"
    : status.state === "unreadable"
      ? "the saved key cannot be read"
      : "no key is saved";

export function LlmAccessSection({
  workspaceSlug,
  canManage,
  keyStatuses,
  summary,
  api,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  /** The state of the key of every registered provider, in the order of the registry. */
  keyStatuses: ProviderKeyStatus[];
  summary: WorkspaceLlmSummary;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  const instanceAccess = instanceAccessOf(summary);
  if (instanceAccess !== null)
    return <InstanceAccessCard access={instanceAccess} />;

  if (!canManage) {
    // The summary is the access of the default provider, the first card.
    const unreadable = keyStatuses[0]?.status.state === "unreadable";
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
            {HOW_STORED}
          </HelpDisclosure>
          <p>
            {summary.configured
              ? "Reviews of this workspace have an LLM key."
              : unreadable
                ? "The saved key cannot be read, so reviews cannot run."
                : "No LLM key is set, so reviews cannot run."}{" "}
            Only an Admin or an Owner of the workspace can change it.
          </p>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {keyStatuses.map(({ provider, status }) => (
              <li key={provider}>
                {llmProviderDescriptors.labelOf(provider)}: {stateOf(status)}.
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {keyStatuses.map(({ provider, status }) => {
        const label = llmProviderDescriptors.labelOf(provider);
        const headingId = `llm-key-heading-${provider}`;
        return (
          <Card key={provider} role="region" aria-labelledby={headingId}>
            <CardHeader>
              <CardTitle>
                <h2
                  id={headingId}
                  className="text-lg font-semibold tracking-tight"
                >
                  {label}
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <HelpDisclosure label="How the key is stored">
                {HOW_STORED}
              </HelpDisclosure>
              <LlmAccessForm
                // Not keyed on the status: the page's data changes after a save (`router.refresh()`),
                // and a form that is mounted again would lose the message that says it worked. It shows
                // the status it gets.
                workspaceSlug={workspaceSlug}
                provider={provider}
                label={label}
                keyStatus={status}
                {...(api === undefined ? {} : { api })}
              />
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
