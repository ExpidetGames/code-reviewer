// SPDX-License-Identifier: Apache-2.0

"use client";
// The step-by-step way to connect GitHub: the six values of an App that was made by hand (docs/github-app.md),
// and a required choice (no default) for what GitHub's API does not report: whether the App can only be installed on its own
// account. The private key, the webhook secret and the client secret are write-only: the page shows whether
// one is saved, an empty field keeps it while the App id (and, for the client secret, the client id) is
// unchanged, and the saved value never reaches this page. The server validates before it saves: the key
// parses, a call to GitHub with the App JWT names the App id and the slug, GitHub accepts the client id and
// secret as a pair.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import type { RequestIssue } from "../../ui/json-request.ts";
import type { GithubConfigView } from "../service.ts";
import { browserGithubApi, type GithubApi } from "./api.ts";
import { describeGithubFailure, describeGithubIssue } from "./messages.ts";
import { useRouter } from "next/navigation";

type Status =
  | { kind: "saved" }
  | { kind: "failed"; text: string; issues: RequestIssue[] }
  | null;

const SECRET_HINT: Record<string, string> = {
  configured:
    "A value is saved. Leave the field empty to keep it, or enter a new one to replace it.",
  unreadable: "The saved value cannot be read. Enter it again.",
  none: "Nothing is saved.",
};

export function ManualForm({
  view,
  api = browserGithubApi,
}: {
  view: GithubConfigView;
  /** Only tests pass this. */
  api?: GithubApi;
}) {
  const ids = useId();
  const router = useRouter();
  const [appId, setAppId] = useState(view.app?.appId ?? "");
  const [slug, setSlug] = useState(view.app?.slug ?? "");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clientId, setClientId] = useState(
    view.userAuthorization.clientId ?? "",
  );
  const [clientSecret, setClientSecret] = useState("");
  const [privateApp, setPrivateApp] = useState<boolean | null>(
    view.app?.privateApp ?? null,
  );
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (privateApp === null) {
      // The radio group is required, so the browser stops this first; this is the same answer in words.
      setStatus({
        kind: "failed",
        text: describeGithubFailure("invalid_input"),
        issues: [{ field: "privateApp", code: "private_app_invalid" }],
      });
      return;
    }
    setPending(true);
    setStatus(null);
    const result = await api.saveApp({
      appId,
      slug,
      privateKey,
      webhookSecret,
      clientId,
      clientSecret,
      privateApp,
    });
    setPending(false);
    if (!result.ok) {
      setStatus({
        kind: "failed",
        text: describeGithubFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    // The secrets are sent once and then forgotten by this page.
    setPrivateKey("");
    setWebhookSecret("");
    setClientSecret("");
    setStatus({ kind: "saved" });
    router.refresh();
  }

  const issues = status?.kind === "failed" ? status.issues : [];
  const issueFor = (field: string) =>
    issues.find((entry) => entry.field === field);
  const error = (field: string) => {
    const issue = issueFor(field);
    return issue ? (
      <p id={`${ids}-${field}-error`} className="field-error">
        {describeGithubIssue(issue)}
      </p>
    ) : null;
  };
  const describedBy = (field: string, hint?: string) =>
    [hint, issueFor(field) ? `${ids}-${field}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  const text = (
    field: string,
    label: string,
    value: string,
    set: (value: string) => void,
    options: { placeholder?: string; hint?: string } = {},
  ) => (
    <div className="field">
      <label htmlFor={`${ids}-${field}`} className="field-label">
        {label}
      </label>
      <input
        id={`${ids}-${field}`}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={options.placeholder}
        value={value}
        onChange={(event) => set(event.target.value)}
        aria-invalid={issueFor(field) !== undefined}
        aria-describedby={describedBy(
          field,
          options.hint === undefined ? undefined : `${ids}-${field}-hint`,
        )}
      />
      {options.hint === undefined ? null : (
        <p id={`${ids}-${field}-hint`} className="muted small">
          {options.hint}
        </p>
      )}
      {error(field)}
    </div>
  );

  return (
    <form onSubmit={submit} className="settings-form" aria-labelledby={ids}>
      <h3 id={ids}>Enter the values by hand</h3>
      <p className="muted">
        Create the App on GitHub as described in <code>docs/github-app.md</code>{" "}
        (use the addresses above), then enter its values here. Nothing is saved
        before GitHub confirms that they belong together.
      </p>
      <fieldset>
        <legend>The App</legend>
        {text("appId", "App ID", appId, setAppId, {
          placeholder: "123456",
          hint: "The number at the top of the App's settings page.",
        })}
        {text("slug", "Slug", slug, setSlug, {
          placeholder: "code-reviewer-acme",
          hint: "The last part of the App's public link, github.com/apps/<slug>.",
        })}
        <div className="field">
          <label htmlFor={`${ids}-privateKey`} className="field-label">
            Private key
          </label>
          <textarea
            id={`${ids}-privateKey`}
            rows={4}
            autoComplete="off"
            spellCheck={false}
            placeholder="The content of the .pem file"
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
            aria-invalid={issueFor("privateKey") !== undefined}
            aria-describedby={describedBy(
              "privateKey",
              `${ids}-privateKey-hint`,
            )}
          />
          <p id={`${ids}-privateKey-hint`} className="muted small">
            {SECRET_HINT[view.secrets.privateKey]} The content of the .pem file,
            with real line breaks or on one line with \n. It is stored encrypted
            and is never shown again.
          </p>
          {error("privateKey")}
        </div>
        <div className="field">
          <label htmlFor={`${ids}-webhookSecret`} className="field-label">
            Webhook secret
          </label>
          <input
            id={`${ids}-webhookSecret`}
            type="password"
            autoComplete="new-password"
            value={webhookSecret}
            onChange={(event) => setWebhookSecret(event.target.value)}
            aria-invalid={issueFor("webhookSecret") !== undefined}
            aria-describedby={describedBy(
              "webhookSecret",
              `${ids}-webhookSecret-hint`,
            )}
          />
          <p id={`${ids}-webhookSecret-hint`} className="muted small">
            {SECRET_HINT[view.secrets.webhookSecret]} The string you entered as
            the webhook secret on GitHub. It is used byte for byte, so no
            trailing space.
          </p>
          {error("webhookSecret")}
        </div>
        <fieldset className="field">
          <legend className="field-label">
            Where can this App be installed?
          </legend>
          <label className="check">
            <input
              type="radio"
              name={`${ids}-privateApp`}
              required
              checked={privateApp === true}
              onChange={() => setPrivateApp(true)}
            />
            <span>Only on its own account (a private App)</span>
          </label>
          <label className="check">
            <input
              type="radio"
              name={`${ids}-privateApp`}
              required
              checked={privateApp === false}
              onChange={() => setPrivateApp(false)}
            />
            <span>On any account (a public App)</span>
          </label>
          <p className="muted small">
            Look at &quot;Where can this GitHub App be installed?&quot; in the
            App&apos;s settings. GitHub does not report it. It decides whether a
            new installation may be attached to the one workspace of a
            single-tenant instance without asking, so there is no default.
          </p>
          {error("privateApp")}
        </fieldset>
      </fieldset>
      <fieldset>
        <legend>Sign in with GitHub (optional)</legend>
        <p className="muted small">
          The client id and a client secret of the same App let people sign in
          with GitHub. Leave the client id empty to turn it off.
        </p>
        {text("clientId", "Client ID", clientId, setClientId, {
          placeholder: "Iv1.0123456789abcdef",
        })}
        <div className="field">
          <label htmlFor={`${ids}-clientSecret`} className="field-label">
            Client secret
          </label>
          <input
            id={`${ids}-clientSecret`}
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            aria-invalid={issueFor("clientSecret") !== undefined}
            aria-describedby={describedBy(
              "clientSecret",
              `${ids}-clientSecret-hint`,
            )}
          />
          <p id={`${ids}-clientSecret-hint`} className="muted small">
            {SECRET_HINT[view.secrets.clientSecret]} It is stored encrypted and
            is never shown again.
          </p>
          {error("clientSecret")}
        </div>
      </fieldset>
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Checking with GitHub..." : "Save and check"}
        </Button>
        {status?.kind === "saved" ? (
          <span role="status">Saved.</span>
        ) : status?.kind === "failed" ? (
          <span role="alert" className="field-error">
            {status.text}
          </span>
        ) : (
          <span role="status" />
        )}
      </div>
      {issueFor("") === undefined ? null : (
        <p role="alert" className="field-error">
          {describeGithubIssue(issueFor("") as RequestIssue)}
        </p>
      )}
    </form>
  );
}
