// SPDX-License-Identifier: Apache-2.0

"use client";
// The billing page of the admin portal (#437, ADR 0005): the Paddle environment, the API key and the webhook secret
// (write-only, like every credential of the portal: the page says whether each is saved and the last four characters,
// the fields are emptied after a save and the saved value never reaches this page), the client-side token, the grace
// days, a connection check, the notification destination, and the switch. Billing is off until the admin switches it
// on; the server judges every step and the form shows the reason it gets back.
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { DangerZone } from "../../components/danger-zone.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
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
import { Switch } from "../../components/ui/switch.tsx";
import {
  STORED_ENCRYPTED_HINT,
  UNREADABLE_SECRET_CAUSE,
} from "../../secrets/messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";
import { browserBillingApi, type BillingApi } from "./billing-api.ts";
import {
  describeBillingFailure,
  describeBillingIssue,
} from "./billing-messages.ts";
import type {
  BillingEnvironment,
  BillingSecretView,
  BillingView,
} from "./billing-view.ts";

type Outcome =
  | { kind: "ok"; text: string }
  | { kind: "failed"; text: string; issues: RequestIssue[] }
  | null;

function isEnvironment(value: string): value is BillingEnvironment {
  return value === "sandbox" || value === "live";
}

function SecretStatus({
  secret,
  what,
}: {
  secret: BillingSecretView;
  what: string;
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
      A {what} is saved
      {secret.lastFour === null ? "." : `, ending in ${secret.lastFour}.`} Leave
      the field empty to keep it.
    </FieldDescription>
  );
}

/** What stands between the admin and the switch, from what the page knows (the server decides in the end). */
function missingItems(billing: BillingView): string[] {
  const items: string[] = [];
  if (billing.apiKey.state !== "configured") items.push("The Paddle API key");
  if (billing.webhookSecret.state !== "configured")
    items.push(
      "The webhook secret (create the notification destination, or enter it)",
    );
  if (billing.clientToken === "") items.push("The client-side token");
  return items;
}

export function BillingForm({
  billing,
  notice,
  api = browserBillingApi,
}: {
  billing: BillingView;
  /** The paragraphs that say what switching billing on does (`enablingNotice`), made by the server. */
  notice: string[];
  /** Only tests pass this. */
  api?: BillingApi;
}) {
  const ids = useId();
  const router = useRouter();
  const [environment, setEnvironment] = useState(billing.environment);
  const [clientToken, setClientToken] = useState(billing.clientToken);
  const [graceDays, setGraceDays] = useState(String(billing.graceDays));
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [saveOutcome, setSaveOutcome] = useState<Outcome>(null);
  const [checkOutcome, setCheckOutcome] = useState<Outcome>(null);
  const [destinationOutcome, setDestinationOutcome] = useState<Outcome>(null);
  const [switchOutcome, setSwitchOutcome] = useState<Outcome>(null);

  const issueOf = (field: string) =>
    saveOutcome?.kind === "failed"
      ? saveOutcome.issues.find((issue) => issue.field === field)
      : undefined;
  const apiKeyIssue = issueOf("apiKey");
  const webhookIssue = issueOf("webhookSecret");
  const tokenIssue = issueOf("clientToken");
  const graceIssue = issueOf("graceDays");
  const missing = missingItems(billing);
  const environmentChanged = environment !== billing.environment;

  async function run(
    name: string,
    work: () => Promise<Outcome>,
    show: (outcome: Outcome) => void,
  ): Promise<Outcome> {
    setPending(name);
    show(null);
    const outcome = await work();
    setPending(null);
    show(outcome);
    // The page's data comes from the server: a refresh shows the new status, the count and "last changed".
    router.refresh();
    return outcome;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const days = Number(graceDays);
    const outcome = await run(
      "save",
      async () => {
        const result = await api.change({
          settings: {
            environment,
            clientToken,
            graceDays: graceDays.trim() === "" ? Number.NaN : days,
            ...(apiKey === "" ? {} : { apiKey }),
            ...(webhookSecret === "" ? {} : { webhookSecret }),
          },
        });
        return result.ok
          ? { kind: "ok", text: "Saved." }
          : {
              kind: "failed",
              text: describeBillingFailure(result.code),
              issues: result.issues,
            };
      },
      setSaveOutcome,
    );
    if (outcome?.kind === "ok") {
      setApiKey("");
      setWebhookSecret("");
    }
  }

  function check() {
    return run(
      "check",
      async () => {
        const result = await api.check();
        if (!result.ok)
          return {
            kind: "failed",
            text: describeBillingFailure(result.code),
            issues: [],
          };
        return result.data.ok
          ? { kind: "ok", text: "Paddle accepted the API key." }
          : {
              kind: "failed",
              text: describeBillingFailure(result.data.error),
              issues: [],
            };
      },
      setCheckOutcome,
    );
  }

  function createDestination() {
    return run(
      "destination",
      async () => {
        const result = await api.createDestination();
        return result.ok
          ? {
              kind: "ok",
              text: "The notification destination was created and its secret saved.",
            }
          : {
              kind: "failed",
              text: describeBillingFailure(result.code),
              issues: [],
            };
      },
      setDestinationOutcome,
    );
  }

  function toggle(enabled: boolean) {
    return run(
      "switch",
      async () => {
        const result = await api.change({ enabled });
        return result.ok
          ? {
              kind: "ok",
              text: enabled ? "Billing is on." : "Billing is off.",
            }
          : {
              kind: "failed",
              text: describeBillingFailure(result.code),
              issues: [],
            };
      },
      setSwitchOutcome,
    );
  }

  const result = (outcome: Outcome) =>
    outcome === null ? null : (
      <Alert
        variant={outcome.kind === "ok" ? "success" : "destructive"}
        role="note"
      >
        <AlertDescription>{outcome.text}</AlertDescription>
      </Alert>
    );

  return (
    <div className="flex flex-col gap-6">
      <HelpDisclosure label="How this works">
        Billing is off until you switch it on here, and while it is off nothing
        of it runs: no page, no route and no call to Paddle. Paddle is the
        merchant of record. Create an API key and a client-side token in the
        Paddle dashboard, for the environment you choose. The API key and the
        webhook secret are stored encrypted on this server with the key of this
        instance (APP_SECRET), so anyone who holds both can decrypt them. Only
        an instance admin can see or change this page.
      </HelpDisclosure>

      <form
        onSubmit={(event) => void submit(event)}
        aria-label="Billing settings"
        className="flex flex-col gap-6"
      >
        <Card role="region" aria-labelledby={`${ids}-paddle`}>
          <CardHeader>
            <CardTitle>
              <h2
                id={`${ids}-paddle`}
                className="text-lg font-semibold tracking-tight"
              >
                Paddle
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field>
              <FieldLabel id={`${ids}-environment`}>Environment</FieldLabel>
              <RadioGroup
                value={environment}
                onValueChange={(value) => {
                  if (isEnvironment(value)) setEnvironment(value);
                }}
                aria-labelledby={`${ids}-environment`}
                disabled={billing.enabled}
                className="gap-2"
              >
                {(["sandbox", "live"] as const).map((value) => (
                  <FieldLabel
                    key={value}
                    htmlFor={`${ids}-${value}`}
                    className="flex cursor-pointer items-center gap-3"
                  >
                    <RadioGroupItem value={value} id={`${ids}-${value}`} />
                    <span>{value === "sandbox" ? "Sandbox" : "Live"}</span>
                  </FieldLabel>
                ))}
              </RadioGroup>
              {billing.enabled ? (
                <FieldDescription>
                  Switch billing off to change the environment.
                </FieldDescription>
              ) : null}
              {environmentChanged ? (
                <Alert variant="warning" role="note">
                  <AlertDescription>
                    Sandbox and Live have separate API keys, notification
                    destinations and webhook secrets. Enter the key of the new
                    environment together with this change, and create the
                    notification destination again.
                  </AlertDescription>
                </Alert>
              ) : null}
            </Field>

            <Field data-invalid={apiKeyIssue !== undefined}>
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor={`${ids}-api-key`}>API key</FieldLabel>
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
              <SecretStatus secret={billing.apiKey} what="API key" />
              {apiKeyIssue === undefined ? null : (
                <FieldError>{describeBillingIssue(apiKeyIssue)}</FieldError>
              )}
            </Field>

            <Field data-invalid={tokenIssue !== undefined}>
              <FieldLabel htmlFor={`${ids}-token`}>
                Client-side token
              </FieldLabel>
              <Input
                id={`${ids}-token`}
                spellCheck={false}
                autoComplete="off"
                value={clientToken}
                onChange={(event) => setClientToken(event.target.value)}
                aria-invalid={tokenIssue !== undefined}
              />
              <FieldDescription>
                Public by design: Paddle’s checkout loads it in the browser.
              </FieldDescription>
              {tokenIssue === undefined ? null : (
                <FieldError>{describeBillingIssue(tokenIssue)}</FieldError>
              )}
            </Field>

            <Field data-invalid={graceIssue !== undefined}>
              <FieldLabel htmlFor={`${ids}-grace`}>Grace days</FieldLabel>
              <Input
                id={`${ids}-grace`}
                inputMode="numeric"
                value={graceDays}
                onChange={(event) => setGraceDays(event.target.value)}
                aria-invalid={graceIssue !== undefined}
              />
              <FieldDescription>
                How many days a workspace keeps its plan after a payment failed,
                before it is suspended.
              </FieldDescription>
              {graceIssue === undefined ? null : (
                <FieldError>{describeBillingIssue(graceIssue)}</FieldError>
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
                secret={billing.webhookSecret}
                what="webhook secret"
              />
              {webhookIssue === undefined ? null : (
                <FieldError>{describeBillingIssue(webhookIssue)}</FieldError>
              )}
            </Field>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={pending === "save"}
            loadingLabel="Saving the billing settings"
          >
            Save
          </Button>
          <StatusRegion>{result(saveOutcome)}</StatusRegion>
        </div>
      </form>

      <Card role="region" aria-labelledby={`${ids}-connection`}>
        <CardHeader>
          <CardTitle>
            <h2
              id={`${ids}-connection`}
              className="text-lg font-semibold tracking-tight"
            >
              Connection and notification destination
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            The check makes one harmless read at Paddle with the saved API key.
            The notification destination tells Paddle to send its events to this
            app; Paddle’s answer holds the secret that signs them, which is
            saved for you. Save your changes first.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              loading={pending === "check"}
              loadingLabel="Checking the connection"
              disabled={billing.apiKey.state !== "configured"}
              onClick={() => void check()}
            >
              Check connection
            </Button>
            <Button
              variant="secondary"
              loading={pending === "destination"}
              loadingLabel="Creating the notification destination"
              disabled={
                billing.apiKey.state !== "configured" ||
                billing.webhookSecret.state === "configured"
              }
              onClick={() => void createDestination()}
            >
              Create notification destination
            </Button>
          </div>
          <StatusRegion>
            {result(checkOutcome)}
            {result(destinationOutcome)}
          </StatusRegion>
        </CardContent>
      </Card>

      <Card role="region" aria-labelledby={`${ids}-switch`}>
        <CardHeader>
          <CardTitle>
            <h2
              id={`${ids}-switch`}
              className="text-lg font-semibold tracking-tight"
            >
              Billing is {billing.enabled ? "on" : "off"}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {billing.enabled ? null : (
            <>
              <div className="flex flex-col gap-2 text-sm">
                {notice.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              {missing.length === 0 ? null : (
                <div className="text-sm">
                  <p className="font-medium">
                    Before billing can be switched on:
                  </p>
                  <ul className="list-disc pl-5">
                    {missing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <div className="flex items-center gap-3">
            <Switch
              id={`${ids}-enabled`}
              checked={billing.enabled}
              disabled={pending === "switch"}
              onCheckedChange={(checked) => void toggle(checked)}
            />
            <FieldLabel htmlFor={`${ids}-enabled`}>
              {billing.enabled ? "Billing is on" : "Switch billing on"}
            </FieldLabel>
          </div>
          <FieldDescription>
            Switching on makes the connection check again and needs the API key,
            the webhook secret and the client-side token. Switching off is
            always possible.
          </FieldDescription>
          <StatusRegion>{result(switchOutcome)}</StatusRegion>
        </CardContent>
      </Card>

      {(
        [
          ["apiKey", "API key", billing.apiKey],
          ["webhookSecret", "webhook secret", billing.webhookSecret],
        ] as const
      ).map(([which, what, secret]) =>
        secret.state === "not_configured" || billing.enabled ? null : (
          <DangerZone
            key={which}
            title={`Remove the ${what}`}
            description={`Only when this instance should no longer use this ${what}.`}
            actionLabel={`Remove the ${what}`}
            confirmTitle={`Remove the ${what}?`}
            confirmDescription="Billing stays off until a new one is saved."
            confirmLabel={`Remove the ${what}`}
            onConfirm={() =>
              void run(
                `remove-${which}`,
                async () => {
                  const removed = await api.change({ removeSecret: which });
                  return removed.ok
                    ? { kind: "ok", text: "Removed." }
                    : {
                        kind: "failed",
                        text: describeBillingFailure(removed.code),
                        issues: [],
                      };
                },
                setSaveOutcome,
              )
            }
          />
        ),
      )}
    </div>
  );
}
