// SPDX-License-Identifier: Apache-2.0

"use client";
// The providers whose address is not trusted (#554): the address models.dev states changed, or was refused. The old and
// the new address are shown next to each other as text; only an address that passed the check (https, a public host, no
// port) can be confirmed, because confirming sends the keys of that provider there. A refused address has no confirm: its
// text is shown as it came, escaped, and the reason is a sentence. Until the admin confirms, the provider and all its
// models are blocked; doing nothing keeps them blocked, and a fetch that finds the old address again unblocks them.
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
import type { ProviderView } from "../../models-dev/admin-service.ts";
import { browserCatalogModelsApi, type CatalogModelsApi } from "./api.ts";
import {
  escapeInvisible,
  safeHttpsHref,
  stripInvisible,
  truncateText,
} from "./format.ts";
import {
  URL_PROBLEM_COPY,
  URL_STATE_LABEL,
  describeCatalogError,
} from "./messages.ts";
import { URL_BADGE } from "./status-badges.ts";

/** The most providers listed at once; a mass change is stopped by the fetch guard long before. */
const MAX_LISTED = 50;

/** The most of an address that is shown when it cannot be confirmed; a confirmable one is shown whole. */
const REFUSED_ADDRESS_CHARS = 200;

/**
 * An address that can be acted on is shown whole (a cut would hide the end of a look-alike host such as
 * `api.openai.com.<63 characters>.attacker.net`) with its invisible characters written out, so that what is read is
 * what is trusted. One that cannot be confirmed is only shown: stripped of invisible characters, then cut.
 */
function addressText(text: string, confirmable: boolean): string {
  return confirmable
    ? escapeInvisible(text)
    : truncateText(stripInvisible(text), REFUSED_ADDRESS_CHARS).text;
}

/** An address from models.dev: text, and a link only when it is a plain https address. */
function Address({ text }: { text: string | null }) {
  if (text === null) return <span className="text-muted-foreground">none</span>;
  const href = safeHttpsHref(text);
  // The trusted address passed the check once: whole, like a confirmable one.
  const code = (
    <code className="font-mono text-xs break-all">
      {addressText(text, href !== null)}
    </code>
  );
  return href === null ? (
    code
  ) : (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline-offset-4 hover:underline"
    >
      {code}
    </a>
  );
}

export function ProvidersPanel({
  providers,
  api = browserCatalogModelsApi,
}: {
  /** The providers whose address is not trusted. */
  providers: readonly ProviderView[];
  /** Only tests pass this. */
  api?: CatalogModelsApi;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<ProviderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{
    provider: string;
    text: string;
  } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  if (providers.length === 0) return null;
  const listed = providers.slice(0, MAX_LISTED);

  async function confirm(provider: ProviderView) {
    const pendingUrl = provider.url.pendingUrl;
    if (pendingUrl === null) return;
    setBusy(true);
    setFailed(null);
    setSaved(null);
    const result = await api.confirmUrl({
      providerId: provider.id,
      pendingUrl,
    });
    setBusy(false);
    if (!result.ok) {
      setFailed({
        provider: provider.id,
        text: describeCatalogError(result.code),
      });
      // What the admin saw is not what is stored: show what is.
      router.refresh();
      return;
    }
    setSaved(provider.id);
    router.refresh();
  }

  return (
    <Card role="region" aria-label="Provider addresses that need you">
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg font-semibold tracking-tight">
            Provider addresses that need you
          </h2>
        </CardTitle>
        <CardDescription>
          These providers are blocked: no key is sent to them, and none of their
          models can run, until the address is trusted. Confirming sends the
          keys of that provider to the new address.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-4">
          {listed.map((provider) => {
            const canConfirm =
              provider.url.state === "url_changed" &&
              provider.url.problem === null &&
              provider.url.pendingUrl !== null;
            return (
              <li
                key={provider.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-4"
                aria-label={`Address of ${truncateText(provider.name, 60).text}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {truncateText(provider.name, 60).text}
                  </span>
                  <Badge variant={URL_BADGE[provider.url.state]}>
                    {URL_STATE_LABEL[provider.url.state]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {`${String(provider.models)} model(s) blocked`}
                  </span>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">Trusted address</dt>
                    <dd>
                      <Address text={provider.url.trustedUrl} />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">
                      {provider.url.problem === null
                        ? "New address"
                        : "Address models.dev states (refused)"}
                    </dt>
                    <dd>
                      {/* The new address is text only; a refused one is the raw text of models.dev. */}
                      {provider.url.pendingUrl === null ? (
                        <span className="text-muted-foreground">none</span>
                      ) : (
                        <code className="font-mono text-xs break-all">
                          {addressText(provider.url.pendingUrl, canConfirm)}
                        </code>
                      )}
                    </dd>
                  </div>
                </dl>
                {provider.url.problem === null ? null : (
                  <p className="text-sm">
                    {URL_PROBLEM_COPY[provider.url.problem]} It cannot be
                    confirmed.
                  </p>
                )}
                {canConfirm ? (
                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      aria-label={`Confirm the new address of ${truncateText(provider.name, 60).text}`}
                      onClick={() => setConfirming(provider)}
                    >
                      Confirm the new address
                    </Button>
                  </div>
                ) : null}
                {failed?.provider === provider.id ? (
                  <Alert variant="destructive">
                    <AlertDescription>{failed.text}</AlertDescription>
                  </Alert>
                ) : null}
                {saved === provider.id ? (
                  <p role="status" className="text-sm text-success">
                    The new address is trusted.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {providers.length > listed.length ? (
          <p className="text-sm text-muted-foreground">
            {`${String(providers.length - listed.length)} more providers are blocked.`}
          </p>
        ) : null}
      </CardContent>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => (open ? undefined : setConfirming(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trust the new address?</AlertDialogTitle>
            <AlertDialogDescription>
              The keys of{" "}
              {confirming === null
                ? "this provider"
                : truncateText(confirming.name, 60).text}{" "}
              will be sent to{" "}
              <code className="font-mono break-all">
                {confirming?.url.pendingUrl === null ||
                confirming?.url.pendingUrl === undefined
                  ? ""
                  : addressText(confirming.url.pendingUrl, true)}
              </code>
              . Confirm only an address you recognise. The change is written to
              the server log with your account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it blocked</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const provider = confirming;
                setConfirming(null);
                if (provider !== null) void confirm(provider);
              }}
            >
              Trust the new address
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
