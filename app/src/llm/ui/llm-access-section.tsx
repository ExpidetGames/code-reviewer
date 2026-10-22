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
import { CatalogProvidersCard } from "../../native-providers/ui/catalog-providers-card.tsx";
import type { NativeProviderView } from "../../native-providers/catalog.ts";
import { llmProviderDescriptors } from "../providers/index.ts";
import type {
  ProviderKeyStatus,
  WorkspaceLlmKeyStatus,
} from "../workspace-key.ts";
import type { KeyMode } from "../../workspaces/entitlements.ts";
import type { LlmKeyApi } from "./api.ts";
import type { LlmKeyModeApi } from "./key-mode-api.ts";
import { KeyModeCard } from "./key-mode-card.tsx";
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
            className="text-lg leading-7 font-semibold tracking-normal"
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

/** The catalog providers of a workspace on its own key (#555): what the catalog offers and which of them have a key. */
export type CatalogProvidersData = {
  providers: readonly NativeProviderView[];
  keyStatuses: readonly ProviderKeyStatus[];
};

/**
 * The choice of the key mode (#496), given only while billing is on: what applies now, and whether a key of the workspace's own is
 * stored. With it the page offers the choice and keeps the key forms whichever key is chosen; without it (billing off) the page is
 * what it always was.
 */
export type KeyChoice = { keyMode: KeyMode; hasOwnKey: boolean };

export function LlmAccessSection({
  workspaceSlug,
  canManage,
  keyStatuses,
  catalog,
  summary,
  keyChoice,
  api,
  keyModeApi,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  /** The state of the key of every registered provider, in the order of the registry. */
  keyStatuses: ProviderKeyStatus[];
  /**
   * The providers of the models.dev catalog (#555). Left out, the page has the two providers of the registry only. Never given
   * for a workspace on the instance's access: it has no provider to choose.
   */
  catalog?: CatalogProvidersData;
  summary: WorkspaceLlmSummary;
  /** Billing is on (#496): the workspace chooses whose key its reviews use. */
  keyChoice?: KeyChoice;
  /** Only tests pass these. */
  api?: LlmKeyApi;
  keyModeApi?: LlmKeyModeApi;
}) {
  const instanceAccess = instanceAccessOf(summary);
  if (instanceAccess !== null && keyChoice === undefined)
    return <InstanceAccessCard access={instanceAccess} />;
  const choiceCard =
    keyChoice === undefined ? null : (
      <KeyModeCard
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        keyMode={keyChoice.keyMode}
        hasOwnKey={keyChoice.hasOwnKey}
        {...(keyModeApi === undefined ? {} : { api: keyModeApi })}
      />
    );

  const catalogCard =
    catalog === undefined || catalog.providers.length === 0 ? null : (
      <CatalogProvidersCard
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        providers={catalog.providers}
        keyStatuses={catalog.keyStatuses}
        {...(api === undefined ? {} : { api })}
      />
    );

  if (!canManage) {
    // The summary is the access of the default provider, the first card.
    const unreadable = keyStatuses[0]?.status.state === "unreadable";
    return (
      <div className="flex flex-col gap-6">
        {choiceCard}
        <Card role="region" aria-labelledby="llm-key-heading">
          <CardHeader>
            <CardTitle>
              <h2
                id="llm-key-heading"
                className="text-lg leading-7 font-semibold tracking-normal"
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
        {catalogCard}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {choiceCard}
      {keyStatuses.map(({ provider, status }) => {
        const label = llmProviderDescriptors.labelOf(provider);
        const headingId = `llm-key-heading-${provider}`;
        return (
          <Card key={provider} role="region" aria-labelledby={headingId}>
            <CardHeader>
              <CardTitle>
                <h2
                  id={headingId}
                  className="text-lg leading-7 font-semibold tracking-normal"
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
      {catalogCard}
    </div>
  );
}
