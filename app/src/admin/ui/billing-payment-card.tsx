// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The payment adapter and the Stripe credentials (#504, ADR 0006, 2.14). The adapter is `manual` (no payment provider: the
// operator credits workspaces by hand) or `stripe`. The Stripe API key and the webhook secret are write-only like every
// credential of the portal: the page says whether each is saved and the last four characters, the fields are emptied after a
// save and the saved value never reaches this page. The key's environment (test or live) is read from its prefix. The
// connection check makes one harmless read at Stripe; "Create webhook endpoint" tells Stripe to post its events to this app and
// saves the signing secret Stripe returns (one that exists already for this app's address is taken over). The server judges
// every step; the card shows the reason it gets back.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../components/ui/radio-group.tsx";
import {
  STORED_ENCRYPTED_HINT,
  UNREADABLE_SECRET_CAUSE,
} from "../../secrets/messages.ts";
import { formatUtc } from "../../ui/format-time.ts";
import type { BillingApi } from "./billing-api.ts";
import {
  describeBillingFailure,
  describeStripeDetail,
  describeBillingIssue,
} from "./billing-messages.ts";
import { OutcomeNote, useBillingRun } from "./billing-run.tsx";
import {
  BILLING_ADAPTER_CHOICES,
  type BillingAdapterChoice,
  type BillingSecretView,
  type BillingView,
} from "./billing-view.ts";

function isAdapter(value: string): value is BillingAdapterChoice {
  return (BILLING_ADAPTER_CHOICES as readonly string[]).includes(value);
}

function SecretStatus({
  secret,
  what,
  article,
}: {
  secret: BillingSecretView;
  what: string;
  /** "A" or "An", for the name that follows. */
  article: string;
}) {
  if (secret.state === "unreadable")
    return (
      <Alert variant="warning" role="note">
        <AlertDescription>
          <strong>The saved {what} cannot be read.</strong>{" "}
          {UNREADABLE_SECRET_CAUSE} Enter it again and save.
        </AlertDescription>
      </Alert>
    );
  if (secret.state === "not_configured")
    return <FieldDescription>No {what} is saved.</FieldDescription>;
  return (
    <FieldDescription>
      {article} {what} is saved
      {secret.lastFour === null ? "." : `, ending in ${secret.lastFour}.`} Leave
      the field empty to keep it.
    </FieldDescription>
  );
}

export function BillingPaymentCard({
  billing,
  api,
}: {
  billing: BillingView;
  api: BillingApi;
}) {
  const product = useProductIdentity();
  const ids = useId();
  const { pending, outcome, run } = useBillingRun();
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const { stripe } = billing;
  const usesStripe = billing.adapter === "stripe";
  const keySaved = stripe.apiKey.state === "configured";

  const issueOf = (field: string) =>
    outcome?.kind === "failed"
      ? outcome.issues.find((issue) => issue.field === field)
      : undefined;
  const apiKeyIssue = issueOf("apiKey");
  const webhookIssue = issueOf("webhookSecret");

  function choose(adapter: BillingAdapterChoice) {
    if (adapter === billing.adapter) return;
    void run("adapter", async () => {
      const result = await api.change({ adapter });
      return result.ok
        ? { kind: "ok", text: "The payment adapter is saved." }
        : {
            kind: "failed",
            text: describeBillingFailure(product, result.code, result.status),
            issues: result.issues,
            missing: [],
          };
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const result = await run("save", async () => {
      const answer = await api.change({
        stripe: {
          ...(apiKey === "" ? {} : { apiKey }),
          ...(webhookSecret === "" ? {} : { webhookSecret }),
        },
      });
      return answer.ok
        ? { kind: "ok", text: "Saved." }
        : {
            kind: "failed",
            text:
              describeBillingFailure(product, answer.code, answer.status) +
              describeStripeDetail(answer.details?.stripe),
            issues: answer.issues,
            missing: [],
          };
    });
    if (result?.kind === "ok") {
      setApiKey("");
      setWebhookSecret("");
    }
  }

  function check() {
    return run("check", async () => {
      const result = await api.check();
      if (!result.ok)
        return {
          kind: "failed",
          text: describeBillingFailure(product, result.code, result.status),
          issues: [],
          missing: [],
        };
      return result.data.ok
        ? {
            kind: "ok",
            text: `Stripe accepted the API key (${result.data.environment === "live" ? "live" : "test"} mode).`,
          }
        : {
            kind: "failed",
            text:
              describeBillingFailure(product, result.data.error) +
              describeStripeDetail(result.data.stripe),
            issues: [],
            missing: [],
          };
    });
  }

  function endpoint(recreate = false) {
    return run(recreate ? "recreate" : "endpoint", async () => {
      const result = await api.createWebhookEndpoint(
        recreate ? { recreate: true } : undefined,
      );
      if (!result.ok)
        return {
          kind: "failed",
          text:
            describeBillingFailure(product, result.code, result.status) +
            describeStripeDetail(result.details?.stripe),
          issues: [],
          missing: [],
        };
      if (recreate)
        return {
          kind: "ok",
          text: "The webhook endpoint was replaced and its new secret saved.",
        };
      return {
        kind: "ok",
        text: result.data.created
          ? "The webhook endpoint is in place and its secret saved."
          : "The webhook endpoint of this app exists at Stripe already; its saved secret is in use.",
      };
    });
  }

  return (
    <Card role="region" aria-labelledby={`${ids}-payment`}>
      <CardHeader>
        <CardTitle>
          <h2
            id={`${ids}-payment`}
            className="text-lg font-semibold tracking-tight"
          >
            Payment adapter
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Field>
          <FieldLabel id={`${ids}-adapter`}>Adapter</FieldLabel>
          <RadioGroup
            value={billing.adapter}
            onValueChange={(value) => {
              if (isAdapter(value)) choose(value);
            }}
            aria-labelledby={`${ids}-adapter`}
            disabled={billing.enabled || pending === "adapter"}
            className="gap-2"
          >
            {(
              [
                [
                  "manual",
                  "Manual: no payment provider; you credit workspaces yourself",
                ],
                [
                  "stripe",
                  "Stripe: workspaces top up themselves (Stripe Managed Payments)",
                ],
              ] as const
            ).map(([value, label]) => (
              <FieldLabel
                key={value}
                htmlFor={`${ids}-adapter-${value}`}
                className="flex cursor-pointer items-center gap-3"
              >
                <RadioGroupItem value={value} id={`${ids}-adapter-${value}`} />
                <span>{label}</span>
              </FieldLabel>
            ))}
          </RadioGroup>
          {billing.enabled ? (
            <FieldDescription>
              Switch billing off to change the adapter.
            </FieldDescription>
          ) : null}
        </Field>

        {usesStripe ? (
          <form
            onSubmit={(event) => void save(event)}
            aria-label="Stripe credentials"
            className="flex flex-col gap-5"
          >
            <Field data-invalid={apiKeyIssue !== undefined}>
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor={`${ids}-api-key`}>
                  Stripe API key
                </FieldLabel>
                <InfoHint label="About the saved API key">
                  {STORED_ENCRYPTED_HINT}
                </InfoHint>
              </div>
              <Input
                id={`${ids}-api-key`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                aria-invalid={apiKeyIssue !== undefined}
              />
              <SecretStatus
                secret={stripe.apiKey}
                what="API key"
                article="An"
              />
              {apiKeyIssue === undefined ? null : (
                <FieldError>{describeBillingIssue(apiKeyIssue)}</FieldError>
              )}
              {stripe.environment === null ? null : (
                <FieldDescription>
                  Environment, read from the key:{" "}
                  <strong>
                    {stripe.environment === "live" ? "live" : "test"} mode
                  </strong>
                  .
                </FieldDescription>
              )}
            </Field>

            <Field data-invalid={webhookIssue !== undefined}>
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor={`${ids}-webhook`}>
                  Webhook secret
                </FieldLabel>
                <InfoHint label="About the saved webhook secret">
                  {STORED_ENCRYPTED_HINT}
                </InfoHint>
              </div>
              <Input
                id={`${ids}-webhook`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={webhookSecret}
                onChange={(event) => setWebhookSecret(event.target.value)}
                aria-invalid={webhookIssue !== undefined}
              />
              <SecretStatus
                secret={stripe.webhookSecret}
                what="webhook secret"
                article="A"
              />
              {webhookIssue === undefined ? null : (
                <FieldError>{describeBillingIssue(webhookIssue)}</FieldError>
              )}
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                loading={pending === "save"}
                loadingLabel="Saving the Stripe credentials"
              >
                Save credentials
              </Button>
              <Button
                variant="secondary"
                loading={pending === "check"}
                loadingLabel="Checking the connection"
                disabled={!keySaved}
                onClick={() => void check()}
              >
                Check connection
              </Button>
            </div>
            <FieldDescription>
              {stripe.checkedAt === null
                ? "The connection has not been checked with the saved key."
                : `The connection check passed on ${formatUtc(stripe.checkedAt)}.`}{" "}
              The check makes one harmless read at Stripe. Save your changes
              first.
            </FieldDescription>

            <div className="flex flex-col gap-3 text-sm">
              <p>
                Stripe posts its events to{" "}
                <code className="break-all">{stripe.webhookUrl}</code>.{" "}
                {stripe.webhookUrlPublic
                  ? "Create the webhook endpoint to have Stripe sign its events with a secret that is saved for you; one that exists already for this address is taken over. Or make an endpoint in the Stripe dashboard and enter its secret above."
                  : "This is not a public https address, so Stripe cannot reach it. Set the public https address of this app (BETTER_AUTH_URL), or make an endpoint in the Stripe dashboard and enter its secret above."}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  loading={pending === "endpoint"}
                  loadingLabel="Creating the webhook endpoint"
                  disabled={!keySaved || !stripe.webhookUrlPublic}
                  onClick={() => void endpoint()}
                >
                  Create webhook endpoint
                </Button>
                <Button
                  variant="secondary"
                  loading={pending === "recreate"}
                  loadingLabel="Replacing the webhook endpoint"
                  disabled={
                    !keySaved || !stripe.webhookUrlPublic || billing.enabled
                  }
                  onClick={() => void endpoint(true)}
                >
                  Replace webhook endpoint
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <FieldDescription>
            With the manual adapter workspaces cannot top up themselves: you
            credit them below. Nothing is sent to a payment provider.
          </FieldDescription>
        )}

        <OutcomeNote outcome={outcome} />
      </CardContent>
    </Card>
  );
}
