// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Other providers" card of the LLM access page (#555): the providers of the models.dev catalog a workspace on its own key may
// use for Dynamic Review, searchable, each with the write-only key form of the generic adapter (save, test). One key per provider,
// stored and revealed like the key of a registry provider; a key of one provider is never used for another. The list is
// what the server offered: an excluded provider (cloud IAM) or one whose address is blocked is not in it. A member who may not
// manage keys is told which providers have one.
import { useId, useMemo, useState } from "react";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { cn } from "../../lib/utils.ts";
import type { LlmKeyApi } from "../../llm/ui/api.ts";
import { LlmAccessForm } from "../../llm/ui/llm-access-form.tsx";
import type {
  ProviderKeyStatus,
  WorkspaceLlmKeyStatus,
} from "../../llm/workspace-key.ts";
import type { NativeProviderView } from "../catalog.ts";

const HOW_STORED =
  "Reviews run with the API key of this workspace, and the provider bills that account. The key is stored encrypted on this server and is never shown again. The operator of this instance holds the key that encrypts it and can technically decrypt it.";

const keyedOf = (status: WorkspaceLlmKeyStatus | undefined) =>
  status !== undefined && status.state !== "not_configured";

const plural = (count: number) => (count === 1 ? "1 model" : `${count} models`);

export function CatalogProvidersCard({
  workspaceSlug,
  canManage,
  providers,
  keyStatuses,
  api,
}: {
  workspaceSlug: string;
  /** An Admin or an Owner of the workspace (`manage_llm_key`). */
  canManage: boolean;
  /** The providers the catalog offers, by slug. */
  providers: readonly NativeProviderView[];
  /** The state of the key of each catalog provider the workspace holds a key slot for. */
  keyStatuses: readonly ProviderKeyStatus[];
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  const ids = useId();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const statusOf = useMemo(
    () => new Map(keyStatuses.map((entry) => [entry.provider, entry.status])),
    [keyStatuses],
  );
  const offered = useMemo(
    () => new Set(providers.map((provider) => provider.id)),
    [providers],
  );
  // Providers with a key come first, then by name.
  const sorted = useMemo(
    () =>
      [...providers].sort(
        (a, b) =>
          Number(keyedOf(statusOf.get(b.id))) -
            Number(keyedOf(statusOf.get(a.id))) ||
          a.label.localeCompare(b.label),
      ),
    [providers, statusOf],
  );
  const needle = query.trim().toLowerCase();
  const shown = sorted.filter(
    (provider) =>
      needle === "" ||
      provider.label.toLowerCase().includes(needle) ||
      provider.id.includes(needle.replaceAll("-", "_")),
  );
  const selected = providers.find((provider) => provider.id === chosen);
  // A key whose provider the catalog does not offer now (its address is blocked, or models.dev dropped it).
  const orphaned = keyStatuses.filter(
    (entry) => keyedOf(entry.status) && !offered.has(entry.provider),
  );
  const headingId = `${ids}-heading`;

  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardHeader>
        <CardTitle>
          <h2
            id={headingId}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            Other providers
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Dynamic Review can run on a model of any of these providers with your
          own key. Add the key here, then choose the model in the review
          settings of a project. Diff Review uses the providers above.
        </p>
        <HelpDisclosure label="How the key is stored">
          {HOW_STORED}
        </HelpDisclosure>

        {!canManage ? (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {sorted
              .filter((provider) => keyedOf(statusOf.get(provider.id)))
              .map((provider) => (
                <li key={provider.id}>{provider.label}: a key is saved.</li>
              ))}
          </ul>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor={`${ids}-search`}>
                Search providers
              </FieldLabel>
              <Input
                id={`${ids}-search`}
                type="search"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No provider matches.
              </p>
            ) : (
              <ul
                aria-label="Providers"
                className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-background p-1"
              >
                {shown.map((provider) => {
                  const keyed = keyedOf(statusOf.get(provider.id));
                  const unreadable =
                    statusOf.get(provider.id)?.state === "unreadable";
                  return (
                    <li key={provider.id}>
                      <button
                        type="button"
                        aria-pressed={provider.id === chosen}
                        onClick={() => setChosen(provider.id)}
                        className={cn(
                          "flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                          provider.id === chosen && "bg-accent",
                        )}
                      >
                        <span className="flex flex-col">
                          <span className="font-semibold text-foreground">
                            {provider.label}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {plural(provider.modelCount)}
                          </span>
                        </span>
                        {unreadable ? (
                          <Badge variant="warning">Key cannot be read</Badge>
                        ) : keyed ? (
                          <Badge variant="success">Key saved</Badge>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {selected === undefined ? null : (
              <div className="flex flex-col gap-3 border-t border-border pt-4">
                <h3 className="text-base font-semibold">{selected.label}</h3>
                <LlmAccessForm
                  key={selected.id}
                  workspaceSlug={workspaceSlug}
                  provider={selected.id}
                  label={selected.label}
                  keyStatus={
                    statusOf.get(selected.id) ?? { state: "not_configured" }
                  }
                  {...(api === undefined ? {} : { api })}
                />
              </div>
            )}
          </>
        )}

        {orphaned.map((entry) => (
          <p key={entry.provider} className="text-sm text-muted-foreground">
            A key is saved for {entry.provider}, which is not available now.
            Reviews cannot use it. It can be removed under Advanced.
          </p>
        ))}
      </CardContent>
    </Card>
  );
}
