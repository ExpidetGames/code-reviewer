// SPDX-License-Identifier: Apache-2.0

"use client";
// The model picker of a project on the workspace's own key, for a Dynamic Review that runs a model of the models.dev catalog (#555):
// the listed tool-calling models of the chosen provider, searchable, with the name, the context size and the price when models.dev
// states one. The list comes from the app's own route (it is large for some providers, so it is not sent with the page). A model
// that is not in the catalog (released today, before the next daily fetch) cannot be picked: the list is the catalog. A saved model
// the catalog does not list now stays the value, with a warning: the run goes on with the last known entry until the provider
// retires it. Nothing here is shown to a workspace on the operator's key (the route and the form refuse it).
import { useEffect, useId, useMemo, useState } from "react";
import { Alert } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { cn } from "../../lib/utils.ts";
import type { NativeModelPrice, NativeModelView } from "../catalog.ts";
import { browserCatalogModelsApi, type CatalogModelsApi } from "./api.ts";
import { OwnKeyCostNote } from "./own-key-cost-note.tsx";

export type { CatalogModelsApi } from "./api.ts";

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; models: readonly NativeModelView[] };

const priceLabel = (price: NativeModelPrice | null) =>
  price === null
    ? "price not listed"
    : `$${price.inputPerMillion} in / $${price.outputPerMillion} out per million tokens`;

export function CatalogModelPicker({
  workspaceSlug,
  provider,
  providerLabel,
  value,
  onChange,
  error,
  disabled = false,
  tokenCap,
  billingOn,
  api,
}: {
  workspaceSlug: string;
  /** The slug of the catalog provider whose models are listed. */
  provider: string;
  providerLabel: string;
  /** The id of the chosen model; empty when none is chosen. */
  value: string;
  onChange: (modelId: string) => void;
  error?: string | undefined;
  disabled?: boolean;
  /** The token cap of a run on an own key. */
  tokenCap: number;
  billingOn: boolean;
  /** Only tests pass this. */
  api?: CatalogModelsApi;
}) {
  const ids = useId();
  // What the route answered for which provider; an answer for another provider than the one shown is not an answer yet.
  const [fetched, setFetched] = useState<{
    provider: string;
    models: readonly NativeModelView[] | null;
  } | null>(null);
  const [query, setQuery] = useState("");
  const client = useMemo(
    () => api ?? browserCatalogModelsApi(workspaceSlug),
    [api, workspaceSlug],
  );

  useEffect(() => {
    let current = true;
    void client.models(provider).then((result) => {
      if (current)
        setFetched({
          provider,
          models: result.ok ? result.data.models : null,
        });
    });
    return () => {
      current = false;
    };
  }, [client, provider]);

  const loaded: Loaded =
    fetched?.provider !== provider
      ? { state: "loading" }
      : fetched.models === null
        ? { state: "failed" }
        : { state: "ready", models: fetched.models };
  const models = loaded.state === "ready" ? loaded.models : [];
  const needle = query.trim().toLowerCase();
  const shown = models.filter(
    (model) =>
      needle === "" ||
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle),
  );
  const chosen = models.find((model) => model.id === value);
  const unlisted =
    loaded.state === "ready" && value !== "" && chosen === undefined;
  const errorId = `${ids}-error`;

  return (
    <div data-field="dynamicModel" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <FieldLabel htmlFor={`${ids}-search`}>Dynamic Review model</FieldLabel>
        <p className="text-sm text-muted-foreground">
          The model the agent uses, from the models {providerLabel} offers that
          can call tools. A model released only recently can take up to a day to
          appear.
        </p>
      </div>
      {value !== "" ? (
        <p className="text-sm">
          Chosen: <span className="font-mono">{value}</span>
          {chosen === undefined ? "" : ` (${chosen.name})`}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No model chosen yet.</p>
      )}
      <Input
        id={`${ids}-search`}
        aria-label="Search models"
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => setQuery(event.target.value)}
      />
      {loaded.state === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading the models…
        </p>
      ) : null}
      {loaded.state === "failed" ? (
        <Alert variant="destructive">
          The models of {providerLabel} could not be loaded. Reload the page and
          try again.
        </Alert>
      ) : null}
      {loaded.state === "ready" && models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The catalog lists no model of {providerLabel} that can call tools.
        </p>
      ) : null}
      {loaded.state === "ready" && models.length > 0 && shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No model matches.</p>
      ) : null}
      {shown.length > 0 ? (
        <ul
          aria-label="Models"
          className="flex max-h-80 flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-background p-1"
        >
          {shown.map((model) => (
            <li key={model.id}>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={model.id === value}
                onClick={() => onChange(model.id)}
                className={cn(
                  "flex min-h-11 w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
                  model.id === value && "bg-accent",
                )}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">
                    {model.name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {model.id}
                  </span>
                  {model.deprecated ? (
                    <Badge variant="warning">Deprecated</Badge>
                  ) : null}
                  {model.alpha ? <Badge variant="warning">Alpha</Badge> : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {model.contextTokens.toLocaleString("en-US")} tokens of
                  context · {priceLabel(model.price)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {unlisted ? (
        <Alert variant="warning" role="status">
          The saved model <span className="font-mono">{value}</span> is not in
          the catalog now. Reviews keep running on the last known entry until
          the provider retires it; choose another model to be safe.
        </Alert>
      ) : null}
      {value !== "" && loaded.state === "ready" ? (
        <OwnKeyCostNote
          price={chosen?.price ?? null}
          tokenCap={tokenCap}
          billingOn={billingOn}
        />
      ) : null}
    </div>
  );
}
