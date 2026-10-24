// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The fetch of the models.dev catalog (#554): when it last worked, when it was last tried, how it ended (the stable code,
// as a sentence) and "Fetch now". A fetch the guard stopped (a large removal, growth, a mass change of addresses) is not
// applied silently: the admin is asked first, with every reason that tripped and the figures the guard measured, and the
// second request names the reasons the admin accepted. A reason that is new in that second fetch asks again. The route has
// a deadline below its function limit and is rate limited; both come back as codes.
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
import {
  isModelsDevFetchErrorCode,
  type GuardFigures,
} from "../../models-dev/errors.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import { formatUtc } from "../../ui/format-time.ts";
import { browserCatalogModelsApi, type CatalogModelsApi } from "./api.ts";
import {
  FETCH_ERROR_COPY,
  describeCatalogError,
  describeGuardFigures,
  isGuardCode,
  type GuardCode,
} from "./messages.ts";

type Outcome =
  | { kind: "applied"; text: string }
  | { kind: "failed"; text: string; retry: boolean };

/** A fetch the guard stopped: every reason that tripped, what it measured, and which reasons the admin did not accept before. */
type GuardStop = {
  reasons: readonly GuardCode[];
  figures: GuardFigures | null;
  fresh: readonly GuardCode[];
};

const FIGURE_KEYS = [
  "unlisted",
  "listed",
  "listedAfter",
  "providersUnlisted",
  "providersListed",
  "enabledUnlisted",
  "enabledListed",
  "newlyBlocked",
  "providers",
  "oversizedProviders",
] as const satisfies readonly (keyof GuardFigures)[];

/** The figures of an answer, or null unless every one is a whole number: nothing else is shown from the answer. */
function figuresOf(value: unknown): GuardFigures | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const figures: Partial<Record<keyof GuardFigures, number>> = {};
  for (const key of FIGURE_KEYS) {
    const figure = record[key];
    if (
      typeof figure !== "number" ||
      !Number.isSafeInteger(figure) ||
      figure < 0
    )
      return null;
    figures[key] = figure;
  }
  return figures as GuardFigures;
}

/** What the page shows of a 409 of the guard: only the guard's own codes and numbers, whatever else the answer says. */
function guardStopOf(
  code: GuardCode,
  details: Record<string, unknown> | undefined,
  accepted: readonly GuardCode[],
): GuardStop {
  const listed = Array.isArray(details?.reasons)
    ? (details.reasons as unknown[]).filter(isGuardCode)
    : [];
  const reasons = [...new Set(listed)];
  if (reasons.length === 0) reasons.push(code);
  return {
    reasons,
    figures: figuresOf(details?.details),
    fresh:
      accepted.length === 0 ? [] : reasons.filter((r) => !accepted.includes(r)),
  };
}

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
  const [guard, setGuard] = useState<GuardStop | null>(null);

  /** `accept` is what the admin looked at and accepts; none for a plain "Fetch now". */
  async function run(accept: readonly GuardCode[] = []) {
    setBusy(true);
    setOutcome(null);
    const result: RequestResult<unknown> = await (accept.length > 0
      ? api.fetchNow({ acceptReasons: accept })
      : api.fetchNow());
    setBusy(false);
    if (result.ok) {
      setOutcome({ kind: "applied", text: "The catalog was fetched." });
      router.refresh();
      return;
    }
    // The guard stopped it and recorded the failure: show the state, then ask.
    if (isGuardCode(result.code)) {
      setGuard(guardStopOf(result.code, result.details, accept));
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
            onClick={() => void run()}
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
                  onClick={() => void run()}
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
              Nothing was changed. Applying it overrides the guard that protects
              the catalog from a broken answer of models.dev: read what it would
              do first. You accept exactly the reasons below; if the next fetch
              trips another one, you are asked again. The change is written to
              the server log with your account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="flex flex-col gap-2 text-sm">
            {guard?.reasons.map((reason) => (
              <li key={reason}>
                {FETCH_ERROR_COPY[reason]}{" "}
                {guard.figures === null
                  ? null
                  : describeGuardFigures(reason, guard.figures)}{" "}
                {guard.fresh.includes(reason) ? (
                  <Badge variant="warning">New since you looked</Badge>
                ) : null}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the catalog as it is</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const accepted = guard?.reasons ?? [];
                setGuard(null);
                void run(accepted);
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
