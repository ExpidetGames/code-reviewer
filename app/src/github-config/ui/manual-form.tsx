// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The step-by-step way to connect GitHub: the six values of an App that was made by hand (docs/github-app.md),
// and a required choice (no default) for what GitHub's API does not report: whether the App can only be installed on its own
// account. The fields are grouped into "App credentials" and "Sign-in (optional)". The private key, the
// webhook secret and the client secret are write-only: the page shows whether one is saved, an empty field
// keeps it while the App id (and, for the client secret, the client id) is unchanged, and the saved value
// never reaches this page. The server validates before it saves: the key parses, a call to GitHub with the
// App JWT names the App id and the slug, GitHub accepts the client id and secret as a pair.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/button.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { FieldError } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import type { RequestIssue } from "../../ui/json-request.ts";
import { STORED_ENCRYPTED_HINT } from "../../secrets/messages.ts";
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

const SECRET_HINT: Record<string, string> = {
  configured: "A value is saved; leave the field empty to keep it.",
  unreadable: "The saved value cannot be read; enter it again.",
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
  const product = useProductIdentity();
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
        text: describeGithubFailure(product, "invalid_input"),
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
        text: describeGithubFailure(product, result.code),
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
      <FieldError id={`${ids}-${field}-error`}>
        {describeGithubIssue(issue)}
      </FieldError>
    ) : null;
  };
  const describedBy = (field: string, hint?: string) =>
    [hint, issueFor(field) ? `${ids}-${field}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  const fieldId = (field: string) => `${ids}-${field}`;

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-6"
      aria-labelledby={ids}
    >
      <h3 id={ids} className="text-base font-semibold text-foreground">
        Enter the values by hand
      </h3>
      <p className="text-sm text-muted-foreground">
        Create the App on GitHub with the addresses above, then enter its values
        here. Nothing is saved before GitHub confirms that they belong together.
      </p>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium text-foreground">
          App credentials
        </legend>
        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldId("appId")}>App ID</Label>
          <Input
            id={fieldId("appId")}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="123456"
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            aria-invalid={issueFor("appId") !== undefined}
            aria-describedby={describedBy("appId", `${ids}-appId-hint`)}
          />
          <p id={`${ids}-appId-hint`} className="text-sm text-muted-foreground">
            The number at the top of the App&apos;s settings page.
          </p>
          {error("appId")}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldId("slug")}>Slug</Label>
          <Input
            id={fieldId("slug")}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="code-reviewer-acme"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            aria-invalid={issueFor("slug") !== undefined}
            aria-describedby={describedBy("slug", `${ids}-slug-hint`)}
          />
          <p id={`${ids}-slug-hint`} className="text-sm text-muted-foreground">
            The last part of the App&apos;s public link, github.com/apps/
            &lt;slug&gt;.
          </p>
          {error("slug")}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <Label htmlFor={fieldId("privateKey")}>Private key</Label>
            <InfoHint label="About the private key">
              The content of the .pem file, with real line breaks or on one line
              with \n. Enter a new value to replace the saved one.{" "}
              {STORED_ENCRYPTED_HINT}
            </InfoHint>
          </div>
          <Textarea
            id={fieldId("privateKey")}
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
          <p
            id={`${ids}-privateKey-hint`}
            className="text-sm text-muted-foreground"
          >
            {SECRET_HINT[view.secrets.privateKey]}
          </p>
          {error("privateKey")}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <Label htmlFor={fieldId("webhookSecret")}>Webhook secret</Label>
            <InfoHint label="About the webhook secret">
              The string you entered as the webhook secret on GitHub. It is used
              byte for byte, so no trailing space.
            </InfoHint>
          </div>
          <Input
            id={fieldId("webhookSecret")}
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
          <p
            id={`${ids}-webhookSecret-hint`}
            className="text-sm text-muted-foreground"
          >
            {SECRET_HINT[view.secrets.webhookSecret]}
          </p>
          {error("webhookSecret")}
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-foreground">
            Where can this App be installed?
          </legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${ids}-privateApp`}
              required
              checked={privateApp === true}
              onChange={() => setPrivateApp(true)}
            />
            <span>Only on its own account (a private App)</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${ids}-privateApp`}
              required
              checked={privateApp === false}
              onChange={() => setPrivateApp(false)}
            />
            <span>On any account (a public App)</span>
          </label>
          <p className="text-sm text-muted-foreground">
            {PRIVATE_APP_WHERE_HINT} GitHub does not report it. It decides
            whether a new installation may be attached to the one workspace of a
            single-tenant setup without asking, so there is no default.
          </p>
          {error("privateApp")}
        </fieldset>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium text-foreground">
          Sign-in (optional)
        </legend>
        <p className="text-sm text-muted-foreground">
          The client id and a client secret of the same App let people sign in
          with GitHub. Leave the client id empty to turn it off.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldId("clientId")}>Client ID</Label>
          <Input
            id={fieldId("clientId")}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Iv1.0123456789abcdef"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            aria-invalid={issueFor("clientId") !== undefined}
            aria-describedby={describedBy("clientId")}
          />
          {error("clientId")}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldId("clientSecret")}>Client secret</Label>
          <Input
            id={fieldId("clientSecret")}
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
          <p
            id={`${ids}-clientSecret-hint`}
            className="text-sm text-muted-foreground"
          >
            {SECRET_HINT[view.secrets.clientSecret]}
          </p>
          {error("clientSecret")}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={pending}
          loadingLabel="Checking with GitHub"
        >
          Save and check
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
      {issueFor("") === undefined ? null : (
        <FieldError>
          {describeGithubIssue(issueFor("") as RequestIssue)}
        </FieldError>
      )}
    </form>
  );
}
