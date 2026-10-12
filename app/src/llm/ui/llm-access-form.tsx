// SPDX-License-Identifier: Apache-2.0

"use client";
// The form of the "LLM access" section, for an Admin or an Owner: the provider, the API key, "Save", "Test
// key" and "Remove key". The key is write-only: the page shows whether one is saved (and its last four
// characters), an empty field keeps it, and the saved value never reaches this page. Changing the provider asks
// for the key again, because a saved key is never carried over to another provider.
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { UNREADABLE_SECRET_CAUSE } from "../../secrets/messages.ts";
import { LLM_PROVIDERS } from "../config.ts";
import type { WorkspaceLlmKeyStatus } from "../workspace-key.ts";
import { browserLlmKeyApi, type LlmKeyApi } from "./api.ts";
import {
  describeKeyTestFailure,
  describeLlmKeyFailure,
  describeLlmKeyIssue,
} from "./messages.ts";

const PROVIDER_LABEL: Record<string, string> = { openrouter: "OpenRouter" };

type Outcome =
  | { kind: "saved"; changed: boolean }
  | { kind: "removed" }
  | { kind: "tested" }
  | { kind: "test_failed"; text: string; detail: string | null }
  | {
      kind: "failed";
      text: string;
      issues: Array<{ field: string; code: string }>;
    }
  | null;

export function LlmAccessForm({
  workspaceSlug,
  keyStatus,
  api = browserLlmKeyApi(workspaceSlug),
}: {
  workspaceSlug: string;
  keyStatus: WorkspaceLlmKeyStatus;
  /** Only tests pass this. */
  api?: LlmKeyApi;
}) {
  const router = useRouter();
  const ids = useId();
  const stored = keyStatus.state === "not_configured" ? null : keyStatus;
  const [provider, setProvider] = useState(
    stored !== null && LLM_PROVIDERS.some((known) => known === stored.provider)
      ? stored.provider
      : LLM_PROVIDERS[0],
  );
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"save" | "test" | "remove" | null>(
    null,
  );
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const issueFor = (field: string) =>
    outcome?.kind === "failed"
      ? outcome.issues.find((issue) => issue.field === field)
      : undefined;
  const keyIssue = issueFor("apiKey");
  const providerIssue = issueFor("provider");

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
        ? { kind: "tested" }
        : {
            kind: "test_failed",
            text: describeKeyTestFailure(result.data.error),
            detail: result.data.detail,
          },
    );
  }

  async function remove() {
    setConfirmRemove(false);
    setOutcome(null);
    setPending("remove");
    const result = await api.remove();
    setPending(null);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text: describeLlmKeyFailure(result.code),
        issues: [],
      });
      return;
    }
    setApiKey("");
    setOutcome({ kind: "removed" });
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => void save(event)}
      className="settings-form"
      aria-label="LLM key"
    >
      {keyStatus.state === "unreadable" ? (
        <p role="alert" className="alert alert-error">
          <strong>The saved key cannot be read.</strong>{" "}
          {UNREADABLE_SECRET_CAUSE} Enter the key again and save. Until then
          reviews of this workspace cannot run.
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={`${ids}-provider`} className="field-label">
          Provider
        </label>
        <select
          id={`${ids}-provider`}
          value={provider}
          onChange={(event) =>
            setProvider(event.target.value as typeof provider)
          }
          aria-invalid={providerIssue !== undefined}
        >
          {LLM_PROVIDERS.map((known) => (
            <option key={known} value={known}>
              {PROVIDER_LABEL[known] ?? known}
            </option>
          ))}
        </select>
        {providerIssue ? (
          <p className="field-error">
            {describeLlmKeyIssue(providerIssue.code)}
          </p>
        ) : null}
      </div>
      <div className="field">
        <div className="field-head">
          <label htmlFor={`${ids}-key`} className="field-label">
            API key
          </label>
          {keyStatus.state === "configured" && !changedProvider ? (
            <InfoHint label="About the saved key">
              Leave the field empty to keep the saved key, or enter a new one to
              replace it.
            </InfoHint>
          ) : null}
        </div>
        <input
          id={`${ids}-key`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          aria-invalid={keyIssue !== undefined}
          aria-describedby={`${ids}-key-hint${keyIssue ? ` ${ids}-key-error` : ""}`}
        />
        <p id={`${ids}-key-hint`} className="muted small">
          {stored === null
            ? "No key is saved."
            : changedProvider
              ? "The saved key was made for another provider and is not carried over; enter the key for this provider."
              : keyStatus.state === "unreadable"
                ? "The saved key cannot be read; enter it again."
                : `A key is saved${keyStatus.state === "configured" && keyStatus.lastFour !== null ? ` (ends in ${keyStatus.lastFour})` : ""}.`}
        </p>
        {keyIssue ? (
          <p id={`${ids}-key-error`} className="field-error">
            {describeLlmKeyIssue(keyIssue.code)}
          </p>
        ) : null}
      </div>
      <div className="form-actions">
        <Button type="submit" disabled={pending !== null}>
          {pending === "save" ? "Saving..." : "Save key"}
        </Button>
        <Button
          variant="secondary"
          disabled={
            pending !== null || (apiKey.trim() === "" && stored === null)
          }
          onClick={() => void test()}
        >
          {pending === "test" ? "Testing..." : "Test key"}
        </Button>
        {stored !== null ? (
          confirmRemove ? (
            <span
              className="check-line"
              role="group"
              aria-label="Confirm removing the key"
            >
              <span>
                Remove the key? Reviews of this workspace cannot run until a new
                one is saved.
              </span>
              <Button
                variant="destructive"
                disabled={pending !== null}
                onClick={() => void remove()}
              >
                Yes, remove it
              </Button>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                Keep it
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              disabled={pending !== null}
              onClick={() => setConfirmRemove(true)}
            >
              Remove key
            </Button>
          )
        ) : null}
      </div>
      <div role="status" aria-live="polite">
        {outcome?.kind === "saved" ? (
          <p className="alert alert-success">
            {outcome.changed ? "The key is saved." : "The saved key is kept."}
          </p>
        ) : null}
        {outcome?.kind === "removed" ? (
          <p className="alert alert-success">The key is removed.</p>
        ) : null}
        {outcome?.kind === "tested" ? (
          <p className="alert alert-success">The provider accepted the key.</p>
        ) : null}
      </div>
      {outcome?.kind === "failed" ? (
        <p role="alert" className="alert alert-error">
          {outcome.text}
        </p>
      ) : null}
      {outcome?.kind === "test_failed" ? (
        <div role="alert" className="alert alert-error">
          <p>{outcome.text}</p>
          {outcome.detail !== null ? (
            <p className="muted small">
              Detail: <span className="mono">{outcome.detail}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
