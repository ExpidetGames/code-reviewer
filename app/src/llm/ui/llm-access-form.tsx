// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The form of one provider's card on the "LLM access" sub-page, for an Admin or an Owner: the API key,
// "Save key" and "Test key". Every provider has its own key and its own form (#426). The key is write-only:
// the page shows whether one is saved (and its last four characters), an empty field keeps it, and the saved
// value never reaches this page. A saved key that was made for another provider than this card's is not
// carried over. Removing the key is a destructive action at the end of the LLM access page, not of the form
// (`remove-workspace-key.tsx`).
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { UNREADABLE_SECRET_CAUSE } from "../../secrets/messages.ts";
import type { WorkspaceLlmKeyStatus } from "../workspace-key.ts";
import { browserLlmKeyApi, type LlmKeyApi } from "./api.ts";
import {
  describeKeyTestFailure,
  describeLlmKeyFailure,
  describeLlmKeyIssue,
} from "./messages.ts";

type Outcome =
  | { kind: "saved"; changed: boolean }
  | { kind: "tested" }
  | { kind: "unverified" }
  | { kind: "test_failed"; text: string; detail: string | null }
  | {
      kind: "failed";
      text: string;
      issues: Array<{ field: string; code: string }>;
    }
  | null;

export function LlmAccessForm({
  workspaceSlug,
  provider,
  label,
  keyStatus,
  api = browserLlmKeyApi(workspaceSlug),
}: {
  workspaceSlug: string;
  /** The provider whose key this form sets. */
  provider: string;
  /** Its name for the person. */
  label: string;
  /** The state of the key of this provider. */
  keyStatus: WorkspaceLlmKeyStatus;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  const router = useRouter();
  const ids = useId();
  const stored = keyStatus.state === "not_configured" ? null : keyStatus;
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const issueFor = (field: string) =>
    outcome?.kind === "failed"
      ? outcome.issues.find((issue) => issue.field === field)
      : undefined;
  const keyIssue = issueFor("apiKey");

  // A saved key is never carried over to another provider: the field must be filled then.
  const changedProvider = stored !== null && stored.provider !== provider;

  async function save(event: FormEvent) {
    event.preventDefault();
    setOutcome(null);
    setPending("save");
    const result = await api.save({ provider, apiKey });
    setPending(null);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text: describeLlmKeyFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    setApiKey("");
    setOutcome({ kind: "saved", changed: result.data.changed });
    router.refresh();
  }

  async function test() {
    setOutcome(null);
    setPending("test");
    const result = await api.test({ provider, apiKey });
    setPending(null);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text:
          result.code === "invalid_input" && result.issues[0] !== undefined
            ? describeLlmKeyIssue(result.issues[0].code)
            : describeLlmKeyFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    setOutcome(
      result.data.ok
        ? result.data.verified === false
          ? { kind: "unverified" }
          : { kind: "tested" }
        : {
            kind: "test_failed",
            text: describeKeyTestFailure(result.data.error),
            detail: result.data.detail,
          },
    );
  }

  const keyHint =
    stored === null
      ? "No key is saved."
      : changedProvider
        ? "The saved key was made for another provider and is not carried over; enter the key for this provider."
        : keyStatus.state === "unreadable"
          ? "The saved key cannot be read; enter it again."
          : `A key is saved${keyStatus.state === "configured" && keyStatus.lastFour !== null ? ` (ends in ${keyStatus.lastFour})` : ""}.`;

  return (
    <form
      onSubmit={(event) => void save(event)}
      aria-label={`${label} LLM key`}
      noValidate
      className="flex flex-col gap-4"
    >
      {keyStatus.state === "unreadable" ? (
        // Server-determined and static: no `role="alert"` (the kit's default), which would interrupt a
        // screen reader on load; a polite status is enough (#178 review N1).
        <Alert variant="destructive" role="status">
          <AlertDescription>
            <strong>The saved key cannot be read.</strong>{" "}
            {UNREADABLE_SECRET_CAUSE} Enter the key again and save. Until then
            reviews of this workspace cannot run.
          </AlertDescription>
        </Alert>
      ) : null}
      <Field data-invalid={keyIssue !== undefined || undefined}>
        <div className="flex items-center gap-2">
          <FieldLabel htmlFor={`${ids}-key`}>API key</FieldLabel>
          {keyStatus.state === "configured" && !changedProvider ? (
            <InfoHint label="About the saved key">
              Leave the field empty to keep the saved key, or enter a new one to
              replace it.
            </InfoHint>
          ) : null}
        </div>
        <Input
          id={`${ids}-key`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          aria-invalid={keyIssue !== undefined}
          aria-describedby={`${ids}-key-hint${keyIssue ? ` ${ids}-key-error` : ""}`}
        />
        <FieldDescription id={`${ids}-key-hint`}>{keyHint}</FieldDescription>
        {keyIssue ? (
          <FieldError id={`${ids}-key-error`}>
            {describeLlmKeyIssue(keyIssue.code)}
          </FieldError>
        ) : null}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={pending === "save"}
          loadingLabel="Saving"
        >
          Save key
        </Button>
        <Button
          variant="secondary"
          loading={pending === "test"}
          loadingLabel="Testing"
          disabled={
            pending !== null || (apiKey.trim() === "" && stored === null)
          }
          onClick={() => void test()}
        >
          Test key
        </Button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {outcome?.kind === "saved" ? (
          <p className="text-sm text-success">
            {outcome.changed ? "The key is saved." : "The saved key is kept."}
          </p>
        ) : null}
        {outcome?.kind === "tested" ? (
          <p className="text-sm text-success">The provider accepted the key.</p>
        ) : null}
        {outcome?.kind === "unverified" ? (
          <p className="text-sm text-muted-foreground">
            This provider has no way to check a key, so it could not be
            verified. If the key is wrong, reviews on this provider fail.
          </p>
        ) : null}
      </div>
      {outcome?.kind === "failed" ? (
        <Alert variant="destructive">
          <AlertDescription>{outcome.text}</AlertDescription>
        </Alert>
      ) : null}
      {outcome?.kind === "test_failed" ? (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{outcome.text}</p>
            {outcome.detail !== null ? (
              <p className="text-sm text-muted-foreground">
                Detail:{" "}
                <span className="font-mono text-foreground">
                  {outcome.detail}
                </span>
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
