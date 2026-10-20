// SPDX-License-Identifier: Apache-2.0

"use client";
// The fetch of the models.dev catalog (#554): when it last worked, when it was last tried, how it ended (the stable code,
// as a sentence) and "Fetch now". A fetch the guard stopped (a large removal, growth, a mass change of addresses) is not
// applied silently: the admin is asked first, with what the guard saw, and the second request carries the explicit
// acceptance. The route has a deadline below its function limit and is rate limited; both come back as codes.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { DescriptionList } from "../../components/description-list.tsx";
import type { FetchState } from "../../models-dev/catalog.ts";
import { isModelsDevFetchErrorCode } from "../../models-dev/errors.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { browserCatalogModelsApi, type CatalogModelsApi } from "./api.ts";
import {
  FETCH_ERROR_COPY,
  describeCatalogError,
  isGuardCode,
} from "./messages.ts";

type Outcome =
  | { kind: "applied"; text: string }
  | { kind: "failed"; text: string; retry: boolean };

function whenOf(iso: string | null): string {
  return iso === null ? "never" : formatUtc(iso);
}

function countOf(summary: FetchState["lastSummary"], key: string): number {
  const value = summary?.[key];
  return typeof value === "number" ? value : 0;
}

/** What a fetch changed, in a sentence. */
function summaryText(summary: FetchState["lastSummary"]): string {
  const parts = [
    `${String(countOf(summary, "newModels"))} new`,
    `${String(countOf(summary, "changedModels"))} changed`,
    `${String(countOf(summary, "unlistedModels"))} unlisted`,
  ];
  return `${parts.join(", ")} of ${String(countOf(summary, "models"))} models`;
}

export function FetchPanel({
  fetch,
  fetchEnabled,
  api = browserCatalogModelsApi,
}: {
  fetch: FetchState | null;
  /** False when `MODELS_DEV_FETCH` switches the fetch off for this instance. */
  fetchEnabled: boolean;
  /** Only tests pass this. */
  api?: CatalogModelsApi;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [guard, setGuard] = useState<string | null>(null);

  async function run(accept: boolean) {
    setBusy(true);
    setOutcome(null);
    const result: RequestResult<unknown> = await (accept
      ? api.fetchNow({ acceptLargeChange: true })
      : api.fetchNow());
    setBusy(false);
    if (result.ok) {
      setOutcome({ kind: "applied", text: "The catalog was fetched." });
      router.refresh();
      return;
    }
    // The guard stopped it and recorded the failure: show the state, then ask.
    if (isGuardCode(result.code)) {
      setGuard(result.code);
      router.refresh();
      return;
    }
    const wait =
      result.code === "fetch_rate_limited" &&
      typeof result.details?.retryAfterSeconds === "number"
        ? ` Try again in ${String(Math.max(1, Math.ceil(result.details.retryAfterSeconds / 60)))} minute(s).`
        : "";
    setOutcome({
      kind: "failed",
      text: `${describeCatalogError(result.code)}${wait}`,
      retry:
        result.code === "fetch_in_progress" || result.code === "unavailable",
    });
    // A fetch that ran and failed has recorded how: show it.
    if (isModelsDevFetchErrorCode(result.code)) router.refresh();
  }

  const failedCode = fetch?.lastStatus === "failed" ? fetch.lastError : null;
  const items = [
    {
      term: "Last successful fetch",
      description: whenOf(fetch?.lastSuccessAt ?? null),
    },
    { term: "Last attempt", description: whenOf(fetch?.lastAttemptAt ?? null) },
    {
      term: "Last result",
      description:
        fetch === null ? (
          "No fetch has run yet."
        ) : fetch.lastStatus === "ok" ? (
          <>
            <Badge variant="success">Worked</Badge>{" "}
            {summaryText(fetch.lastSummary)}
            {countOf(fetch.lastSummary, "retryProviders") > 0 ? (
              <>
                {" "}
                ({String(countOf(fetch.lastSummary, "retryProviders"))} new
                provider(s) did not resolve yet and will be tried again)
              </>
            ) : null}
            {countOf(fetch.lastSummary, "lookupsSkipped") > 0 ? (
              <>
                {" "}
                ({String(countOf(fetch.lastSummary, "lookupsSkipped"))} address
                look-ups ran out of time)
              </>
            ) : null}
          </>
        ) : (
          <>
            <Badge variant="danger">Failed</Badge>{" "}
            {failedCode === null
              ? "The fetch failed."
              : FETCH_ERROR_COPY[failedCode]}{" "}
            {failedCode === null ? null : (
              <code className="font-mono text-xs">{failedCode}</code>
            )}
          </>
        ),
    },
  ];

  return (
    <Card role="region" aria-label="Catalog fetch">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold tracking-tight">
            Catalog fetch
          </h2>
        </CardTitle>
        <CardDescription>
          models.dev is fetched once a day. Fetch now reads it again and keeps
          the catalog as it is if anything looks wrong.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <DescriptionList items={items} />
        {fetchEnabled ? null : (
          <Alert variant="warning">
            <AlertDescription>
              {describeCatalogError("fetch_off")}
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            loading={busy}
            loadingLabel="Fetching"
            disabled={!fetchEnabled}
            onClick={() => void run(false)}
          >
            Fetch now
          </Button>
          <div role="status" aria-live="polite" className="text-sm">
            {outcome?.kind === "applied" ? (
              <span className="text-success">{outcome.text}</span>
            ) : null}
          </div>
        </div>
        {outcome?.kind === "failed" ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>{outcome.text}</span>
              {outcome.retry ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void run(false)}
                >
                  Try again
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      <AlertDialog
        open={guard !== null}
        onOpenChange={(open) => (open ? undefined : setGuard(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply this fetch anyway?</AlertDialogTitle>
            <AlertDialogDescription>
              {guard !== null && isModelsDevFetchErrorCode(guard)
                ? FETCH_ERROR_COPY[guard]
                : ""}{" "}
              Nothing was changed. Applying it overrides the guard that protects
              the catalog from a broken answer of models.dev: look at what it
              would do first. The change is written to the server log with your
              account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the catalog as it is</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setGuard(null);
                void run(true);
              }}
            >
              Apply anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
