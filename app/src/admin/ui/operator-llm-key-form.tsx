// SPDX-License-Identifier: Apache-2.0

"use client";
// The operator's own LLM key (#276, docs/decisions/0001-editions-setup-and-accounts.md, section 2.8): the one key
// of the instance that the workspaces whose key mode is `managed` review with. Write-only like every credential of
// the portal: the page says whether a key is saved, cannot be read or is missing, and the last four characters of a
// long key; the field is emptied after a save and the saved value never reaches this page. The server judges the
// key (src/llm/operator-key.ts); the form shows the reason it gets back. The provider is the default one.
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { DEFAULT_LLM_PROVIDER_LABEL } from "../../llm/providers/index.ts";
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
          workspaces that use the key of the instance cannot run reviews.
        </AlertDescription>
      </Alert>
    );
  if (status.state === "not_configured")
    return (
      <FieldDescription>
        No key is saved. Workspaces that use the key of the instance cannot run
        reviews until there is one.
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

export function OperatorLlmKeyForm({
  status: stored,
  api = browserAdminApi,
}: {
  status: OperatorLlmKeyStatus;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const [apiKey, setApiKey] = useState("");
  const { pending, status, save } = useSave(api);

  // A failed save only sets state; the focus moves after the render that shows the error is committed.
  useEffect(() => {
    if (status === null || status.kind !== "failed") return;
    if (!status.issues.some((issue) => issue.field === "apiKey")) return;
    document.getElementById(`${ids}-api-key`)?.focus();
  }, [ids, status]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void save({ operatorLlmKey: { apiKey } }).then(([outcome]) => {
      if (outcome?.kind === "saved") setApiKey("");
    });
  }

  const issue =
    status?.kind === "failed"
      ? status.issues.find((entry) => entry.field === "apiKey")
      : undefined;

  return (
    <>
      <form
        onSubmit={submit}
        aria-label="LLM key of the instance"
        className="flex flex-col gap-6"
      >
        <HelpDisclosure label="How this works">
          A workspace whose key mode is managed reviews with this key instead of
          a key of its own; its own key stays stored and is not used. Any other
          workspace never uses it. The provider is {DEFAULT_LLM_PROVIDER_LABEL}{" "}
          and bills the account the key belongs to. The key is stored encrypted
          on this server with the key of this instance (APP_SECRET), so anyone
          who holds both can decrypt it. Only an instance admin can save or
          remove it, here; the operator API cannot read or change it.
        </HelpDisclosure>

        <Card role="region" aria-labelledby={`${ids}-key`}>
          <CardHeader>
            <CardTitle>
              <h2
                id={`${ids}-key`}
                className="text-lg font-semibold tracking-tight"
              >
                Key
              </h2>
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
          <Button type="submit" loading={pending} loadingLabel="Saving the key">
            Save key
          </Button>
          <SaveResult status={status} />
        </div>
      </form>

      {stored.state === "not_configured" ? null : (
        <DangerZone
          title="Danger zone"
          description="Only when this instance should no longer offer its own key."
          actionLabel="Remove the key"
          confirmTitle="Remove the key?"
          confirmDescription="Workspaces that use the key of the instance cannot run reviews until a key is saved again. Their own keys are not touched."
          confirmLabel="Remove the key"
          onConfirm={() => void save({ operatorLlmKey: null })}
        />
      )}
    </>
  );
}
