// SPDX-License-Identifier: Apache-2.0

"use client";
// The prompt of an App that was imported or made without the user authorization: "Enable sign-in with GitHub"
// shows the callback address to register in the App's settings and takes the client id and secret (checked
// with GitHub, stored encrypted); and a question GitHub's API cannot answer: can the App only be installed
// on its own account? (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.4 and 2.11.)
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import type { RequestIssue } from "../../ui/json-request.ts";
import type { GithubConfigView } from "../service.ts";
import { browserGithubApi, type GithubApi } from "./api.ts";
import { describeGithubFailure, describeGithubIssue } from "./messages.ts";

type Status =
  | { kind: "saved" }
  | { kind: "failed"; text: string; issues: RequestIssue[] }
  | null;

export function UserAuthorizationForm({
  view,
  api = browserGithubApi,
}: {
  view: GithubConfigView;
  /** Only tests pass this. */
  api?: GithubApi;
}) {
  const ids = useId();
  const router = useRouter();
  const [clientId, setClientId] = useState(
    view.userAuthorization.clientId ?? "",
  );
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    const result = await api.saveUserAuthorization({ clientId, clientSecret });
    setPending(false);
    if (!result.ok) {
      setStatus({
        kind: "failed",
        text: describeGithubFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    setClientSecret("");
    setStatus({ kind: "saved" });
    router.refresh();
  }

  const issues = status?.kind === "failed" ? status.issues : [];
  const issueFor = (field: string) =>
    issues.find((entry) => entry.field === field);

  return (
    <form onSubmit={submit} className="settings-form" aria-labelledby={ids}>
      <h3 id={ids}>Enable sign-in with GitHub</h3>
      <p className="muted">
        In the App&apos;s settings on GitHub, add this address under{" "}
        <strong>Callback URL</strong>, then generate a client secret and enter
        the client id and the secret here. People can then sign in with GitHub,
        and &quot;Connect GitHub&quot; works for workspaces.
      </p>
      <p>
        Callback URL: <code className="mono">{view.urls.callback}</code>
      </p>
      <div className="field">
        <label htmlFor={`${ids}-clientId`} className="field-label">
          Client ID
        </label>
        <input
          id={`${ids}-clientId`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Iv1.0123456789abcdef"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          aria-invalid={issueFor("clientId") !== undefined}
        />
        {issueFor("clientId") ? (
          <p className="field-error">
            {describeGithubIssue(issueFor("clientId") as RequestIssue)}
          </p>
        ) : null}
      </div>
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
        />
        <p className="muted small">
          {view.secrets.clientSecret === "configured"
            ? "A secret is saved. Leave the field empty to keep it while the client id is unchanged."
            : "It is stored encrypted and is never shown again."}
        </p>
        {issueFor("clientSecret") ? (
          <p className="field-error">
            {describeGithubIssue(issueFor("clientSecret") as RequestIssue)}
          </p>
        ) : null}
      </div>
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Checking with GitHub..." : "Save and enable"}
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
    </form>
  );
}

export function PrivateAppForm({
  api = browserGithubApi,
}: {
  /** Only tests pass this. */
  api?: GithubApi;
}) {
  const ids = useId();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  async function answer(privateApp: boolean) {
    setPending(true);
    setStatus(null);
    const result = await api.setPrivateApp(privateApp);
    setPending(false);
    if (!result.ok) {
      setStatus({
        kind: "failed",
        text: describeGithubFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    setStatus({ kind: "saved" });
    router.refresh();
  }

  return (
    <section className="settings-form" aria-labelledby={ids}>
      <h3 id={ids}>Can the App only be installed on its own account?</h3>
      <p className="muted">
        GitHub does not report it, and it is not known for this App. Until you
        answer, new installations are never attached to a workspace without the
        explicit &quot;Connect GitHub&quot; step. Look at &quot;Where can this
        GitHub App be installed?&quot; in the App&apos;s settings.
      </p>
      <div className="form-actions">
        <Button disabled={pending} onClick={() => void answer(true)}>
          Yes, only on its own account
        </Button>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => void answer(false)}
        >
          No, any account can install it
        </Button>
        {status?.kind === "failed" ? (
          <span role="alert" className="field-error">
            {status.text}
          </span>
        ) : (
          <span role="status" />
        )}
      </div>
    </section>
  );
}
