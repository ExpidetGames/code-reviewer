// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The operator's own LLM keys (#276, #427; docs/decisions/0001-editions-setup-and-accounts.md, section 2.8): the keys
// of the instance that the workspaces whose key mode is `managed` review with, one card for each provider. Write-only
// like every credential of the portal: a card says whether a key is saved, cannot be read or is missing, and the last
// four characters of a long key; the field is emptied after a save and the saved value never reaches this page. The
// server judges the key (src/llm/operator-key.ts); the form shows the reason it gets back. "Test key" asks the
// provider whether it accepts the typed key, or the saved one when the field is empty (limited, with counters of its
// own).
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { DangerZone } from "../../components/danger-zone.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
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
import type { OperatorLlmKeyStatus } from "../../llm/operator-key.ts";
import { llmProviderDescriptors } from "../../llm/providers/index.ts";
import {
  describeKeyTestFailure,
  describeLlmKeyFailure,
  describeLlmKeyIssue,
} from "../../llm/ui/messages.ts";
import {
  STORED_ENCRYPTED_HINT,
  UNREADABLE_SECRET_CAUSE,
} from "../../secrets/messages.ts";
import { browserAdminApi, type AdminApi } from "./api.ts";
import { describeAdminIssue } from "./messages.ts";
import { SaveResult, useSave } from "./use-save.tsx";

function StatusLine({ status }: { status: OperatorLlmKeyStatus }) {
  if (status.state === "unreadable")
    return (
      <Alert variant="warning" role="note">
        <AlertDescription>
          <strong>The saved key cannot be read.</strong>{" "}
          {UNREADABLE_SECRET_CAUSE} Enter the key again and save. Until then
          workspaces that use the key of the instance cannot run reviews on this
          provider.
        </AlertDescription>
      </Alert>
    );
  if (status.state === "not_configured")
    return (
      <FieldDescription>
        No key is saved. Workspaces that use the key of the instance cannot run
        reviews on this provider until there is one.
      </FieldDescription>
    );
  return (
    <FieldDescription>
      A key is saved
      {status.lastFour === null ? "." : `, ending in ${status.lastFour}.`} Enter
      a new one to replace it.
    </FieldDescription>
  );
}

type TestOutcome =
  | { kind: "accepted" }
  | { kind: "rejected"; text: string; detail: string | null }
  | { kind: "failed"; text: string };

/** The card of one provider: its key, "Save key", "Test key" and, while a key is stored, the removal. */
export function OperatorLlmKeyForm({
  provider,
  label,
  status: stored,
  api = browserAdminApi,
}: {
  /** The id of the provider whose key this card sets. */
  provider: string;
  /** Its name for the person. */
  label: string;
  status: OperatorLlmKeyStatus;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const [apiKey, setApiKey] = useState("");
  const { pending, status, save } = useSave(api);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<TestOutcome | null>(null);

  // A failed save only sets state; the focus moves after the render that shows the error is committed.
  useEffect(() => {
    if (status === null || status.kind !== "failed") return;
    if (!status.issues.some((issue) => issue.field === "apiKey")) return;
    document.getElementById(`${ids}-api-key`)?.focus();
  }, [ids, status]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTested(null);
    void save({ operatorLlmKeys: { [provider]: { apiKey } } }).then(
      ([outcome]) => {
        if (outcome?.kind === "saved") setApiKey("");
      },
    );
  }

  async function test() {
    setTested(null);
    setTesting(true);
    const result = await api.testLlmKey({ provider, apiKey });
    setTesting(false);
    if (!result.ok) {
      const issue = result.issues[0];
      setTested({
        kind: "failed",
        text:
          result.code === "invalid_input" && issue !== undefined
            ? issue.code === "api_key_unreadable"
              ? describeAdminIssue(issue)
              : describeLlmKeyIssue(issue.code)
            : describeLlmKeyFailure(result.code),
      });
      return;
    }
    setTested(
      result.data.ok
        ? { kind: "accepted" }
        : {
            kind: "rejected",
            text: describeKeyTestFailure(result.data.error),
            detail: result.data.detail,
          },
    );
  }

  const issue =
    status?.kind === "failed"
      ? status.issues.find((entry) => entry.field === "apiKey")
      : undefined;

  return (
    <section aria-label={label} className="flex flex-col gap-6">
      <form
        onSubmit={submit}
        aria-label={`${label} LLM key`}
        className="flex flex-col gap-6"
      >
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-lg font-semibold tracking-tight">{label}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Field data-invalid={issue !== undefined}>
              <div className="flex items-center gap-1">
                <FieldLabel htmlFor={`${ids}-api-key`}>API key</FieldLabel>
                <InfoHint label="About the saved key">
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
                aria-invalid={issue !== undefined}
                aria-describedby={[
                  `${ids}-api-key-hint`,
                  issue === undefined ? undefined : `${ids}-api-key-error`,
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
              <div id={`${ids}-api-key-hint`}>
                <StatusLine status={stored} />
              </div>
              {issue === undefined ? null : (
                <FieldError id={`${ids}-api-key-error`}>
                  {describeAdminIssue(issue)}
                </FieldError>
              )}
            </Field>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            loading={pending}
            loadingLabel="Saving the key"
            disabled={testing}
          >
            Save key
          </Button>
          <Button
            variant="secondary"
            loading={testing}
            loadingLabel="Testing the key"
            disabled={
              pending ||
              (apiKey.trim() === "" && stored.state === "not_configured")
            }
            onClick={() => void test()}
          >
            Test key
          </Button>
          <SaveResult status={status} />
        </div>
        <div aria-live="polite" aria-atomic="true">
          {tested?.kind === "accepted" ? (
            <p className="text-sm text-success">
              The provider accepted the key.
            </p>
          ) : null}
        </div>
        {tested?.kind === "failed" ? (
          <Alert variant="destructive">
            <AlertDescription>{tested.text}</AlertDescription>
          </Alert>
        ) : null}
        {tested?.kind === "rejected" ? (
          <Alert variant="destructive">
            <AlertDescription>
              <p>{tested.text}</p>
              {tested.detail !== null ? (
                <p className="text-sm text-muted-foreground">
                  Detail:{" "}
                  <span className="font-mono text-foreground">
                    {tested.detail}
                  </span>
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </form>

      {stored.state === "not_configured" ? null : (
        <DangerZone
          title={`Danger zone: ${label}`}
          description={`Only when this instance should no longer offer its own ${label} key.`}
          actionLabel="Remove the key"
          confirmTitle={`Remove the ${label} key?`}
          confirmDescription={`Workspaces that use the key of the instance cannot run reviews on ${label} until a key is saved again. Their own keys and the keys of other providers are not touched.`}
          confirmLabel="Remove the key"
          onConfirm={() => void save({ operatorLlmKeys: { [provider]: null } })}
        />
      )}
    </section>
  );
}

/** The whole page: what the keys are for, and the card of each provider in the order of the registry. */
export function OperatorLlmKeys({
  keys,
  api = browserAdminApi,
}: {
  /** The state of the key of each provider, by the provider's id. */
  keys: Record<string, OperatorLlmKeyStatus>;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  return (
    <>
      <HelpDisclosure label="How this works">
        A workspace whose key mode is managed reviews with the key of the
        instance for the provider it runs on, instead of a key of its own; its
        own keys stay stored and are not used. Any other workspace never uses
        these keys. Each provider bills the account its key belongs to, and a
        key is only ever sent to its own provider. The keys are stored encrypted
        on this server with the key of this instance (APP_SECRET), so anyone who
        holds both can decrypt them. Only an instance admin can save or remove
        them, here; the operator API cannot read or change them.
      </HelpDisclosure>
      {Object.entries(keys).map(([provider, status]) => (
        <OperatorLlmKeyForm
          key={provider}
          provider={provider}
          label={llmProviderDescriptors.labelOf(provider)}
          status={status}
          api={api}
        />
      ))}
    </>
  );
}
