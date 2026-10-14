// SPDX-License-Identifier: Apache-2.0

"use client";
// The prompt of an App that was imported or made without the user authorization: "Enable sign-in with GitHub"
// shows the callback address to register in the App's settings and takes the client id and secret (checked
// with GitHub, stored encrypted); and a question GitHub's API cannot answer: can the App only be installed
// on its own account? (docs/decisions/0001-editions-setup-and-accounts.md, sections 2.4 and 2.11.)
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { FieldError } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import type { RequestIssue } from "../../ui/json-request.ts";
import type { GithubConfigView } from "../service.ts";
import { browserGithubApi, type GithubApi } from "./api.ts";
import {
  describeGithubFailure,
  describeGithubIssue,
  PRIVATE_APP_WHERE_HINT,
} from "./messages.ts";

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
    <form
      onSubmit={submit}
      className="flex flex-col gap-4"
      aria-labelledby={ids}
    >
      <h3 id={ids} className="text-base font-semibold text-foreground">
        Enable sign-in with GitHub
      </h3>
      <p className="text-sm text-muted-foreground">
        In the App&apos;s settings on GitHub, add this address under{" "}
        <strong>Callback URL</strong>, then generate a client secret and enter
        the client id and the secret here. People can then sign in with GitHub,
        and &quot;Connect GitHub&quot; works for workspaces.
      </p>
      <p className="text-sm">
        Callback URL:{" "}
        <span className="font-mono break-all">{view.urls.callback}</span>
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-clientId`}>Client ID</Label>
        <Input
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
          <FieldError>
            {describeGithubIssue(issueFor("clientId") as RequestIssue)}
          </FieldError>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-clientSecret`}>Client secret</Label>
        <Input
          id={`${ids}-clientSecret`}
          type="password"
          autoComplete="new-password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          aria-invalid={issueFor("clientSecret") !== undefined}
        />
        {view.secrets.clientSecret === "configured" ? (
          <p className="text-sm text-muted-foreground">
            A secret is saved. Leave the field empty to keep it while the client
            id is unchanged.
          </p>
        ) : null}
        {issueFor("clientSecret") ? (
          <FieldError>
            {describeGithubIssue(issueFor("clientSecret") as RequestIssue)}
          </FieldError>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={pending}
          loadingLabel="Checking with GitHub"
        >
          Save and enable
        </Button>
        {status?.kind === "saved" ? (
          <span role="status" className="text-sm text-muted-foreground">
            Saved.
          </span>
        ) : status?.kind === "failed" ? (
          <span role="alert" className="text-sm text-destructive">
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
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        GitHub does not report it, and it is not known for this App. Until you
        answer, new installations are never attached to a workspace without the
        explicit &quot;Connect GitHub&quot; step. {PRIVATE_APP_WHERE_HINT}
      </p>
      <div className="flex flex-wrap items-center gap-3">
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
          <span role="alert" className="text-sm text-destructive">
            {status.text}
          </span>
        ) : (
          <span role="status" />
        )}
      </div>
    </div>
  );
}
