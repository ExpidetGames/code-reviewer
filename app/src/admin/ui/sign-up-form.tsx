// SPDX-License-Identifier: Apache-2.0

"use client";
// The sign-up rule: everyone, a list of emails or allowed email domains. It changes who can create an
// account from now on; accounts that exist are never deleted or locked by it. An email or domain rule
// shows a notice while it cannot work yet (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.5).
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi } from "./api.ts";
import { LastChanged } from "./last-changed.tsx";
import { describeAdminIssue } from "./messages.ts";
import { FailClosedNotice } from "./notices.tsx";
import { SaveResult, useSave } from "./use-save.tsx";

type RuleKind = "everyone" | "emails" | "domains";

/** The entries a person typed: one per line, or separated by commas, semicolons or spaces. */
export function splitEntries(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function SignUpRuleForm({
  settings,
  api,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const rule = settings.signUpRule.value;
  const [kind, setKind] = useState<RuleKind>(rule.kind);
  const [entriesText, setEntriesText] = useState(
    rule.kind === "everyone" ? "" : rule.entries.join("\n"),
  );
  const { pending, status, save } = useSave(api);

  function submit(event: FormEvent) {
    event.preventDefault();
    void save({
      signUp:
        kind === "everyone"
          ? { kind: "everyone" }
          : { kind, entries: splitEntries(entriesText) },
    });
  }

  const entriesIssue =
    status?.kind === "failed"
      ? status.issues.find((issue) => issue.field === "signUp.entries")
      : undefined;
  const options: Array<{ value: RuleKind; title: string; text: string }> = [
    {
      value: "everyone",
      title: "Everyone",
      text: "Anybody can create an account.",
    },
    {
      value: "emails",
      title: "A list of email addresses",
      text: "Only these addresses can create an account.",
    },
    {
      value: "domains",
      title: "Allowed email domains",
      text: "Addresses at these domains (not their subdomains) can create an account.",
    },
  ];

  return (
    <form onSubmit={submit} className="settings-form" aria-labelledby={ids}>
      <h2 id={ids}>Who may sign up</h2>
      {settings.signUpRuleState.failClosed ? <FailClosedNotice /> : null}
      <fieldset className="setup-options">
        <legend className="sr-only">Sign-up rule</legend>
        {options.map((option) => (
          <label key={option.value} className="setup-option">
            <input
              type="radio"
              name="sign-up-rule"
              checked={kind === option.value}
              onChange={() => setKind(option.value)}
            />
            <span>
              <strong>{option.title}</strong>
              <span className="muted">{option.text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {kind !== "everyone" ? (
        <div className="field">
          <label htmlFor={`${ids}-entries`} className="field-label">
            {kind === "emails" ? "Email addresses" : "Domains"}
          </label>
          <textarea
            id={`${ids}-entries`}
            rows={4}
            value={entriesText}
            onChange={(event) => setEntriesText(event.target.value)}
            aria-invalid={entriesIssue !== undefined}
            aria-describedby={`${ids}-hint`}
          />
          <p id={`${ids}-hint`} className="muted small">
            One per line, or separated by commas. Upper and lower case are the
            same.
          </p>
          {entriesIssue ? (
            <p className="field-error">{describeAdminIssue(entriesIssue)}</p>
          ) : null}
        </div>
      ) : null}
      <p className="muted small">
        Changing the rule affects new accounts and new invitations. Accounts
        that exist are not deleted or locked.
      </p>
      <LastChanged setting={settings.signUpRule} />
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save sign-up rule"}
        </Button>
        <SaveResult status={status} />
      </div>
    </form>
  );
}
