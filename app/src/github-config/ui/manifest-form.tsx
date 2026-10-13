// SPDX-License-Identifier: Apache-2.0

"use client";
// The one-click way to connect GitHub: the browser is sent to GitHub with a manifest, the admin presses
// "Create GitHub App" there, and GitHub sends the browser back with a one-time code that this server trades
// for the App's credentials (docs/decisions/0001-editions-setup-and-accounts.md, section 2.4). Starting the
// flow is one call to the data route; the answer is the manifest and the address of GitHub's creation page,
// which carries a signed, single-use state bound to this session. The manifest is then posted to GitHub by
// the browser, as GitHub documents it.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { FieldError } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import {
  browserGithubApi,
  postManifestToGithub,
  type GithubApi,
} from "./api.ts";
import { describeGithubFailure, describeGithubIssue } from "./messages.ts";
import type { RequestIssue } from "../../ui/json-request.ts";

export function ManifestForm({
  suggestedName,
  configured,
  tenancy,
  api = browserGithubApi,
  post = postManifestToGithub,
}: {
  suggestedName: string;
  /** A GitHub App is configured already: creating another one replaces it, and has to be confirmed. */
  configured: boolean;
  tenancy: "single" | "multi";
  /** Only tests pass these. */
  api?: GithubApi;
  post?: (postUrl: string, manifest: string) => void;
}) {
  const ids = useId();
  const [name, setName] = useState(suggestedName);
  const [organization, setOrganization] = useState("");
  const [replace, setReplace] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{
    text: string;
    issues: RequestIssue[];
  } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    const result = await api.startManifest({ name, organization, replace });
    if (!result.ok) {
      setPending(false);
      setFailure({
        text: describeGithubFailure(result.code),
        issues: result.issues,
      });
      return;
    }
    // The browser leaves for GitHub; this page does not come back to this state.
    post(result.data.postUrl, result.data.manifest);
  }

  const issueFor = (field: string) =>
    failure?.issues.find((entry) => entry.field === field);
  const error = (field: string) => {
    const issue = issueFor(field);
    return issue ? (
      <FieldError id={`${ids}-${field}-error`}>
        {describeGithubIssue(issue)}
      </FieldError>
    ) : null;
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-6"
      aria-labelledby={ids}
    >
      <h3 id={ids} className="text-base font-semibold text-foreground">
        Create the App with one click
      </h3>
      <p className="text-sm text-muted-foreground">
        GitHub opens with everything filled in: the name, this instance&apos;s
        address, the webhook, the permissions and the events. Press{" "}
        <strong>Create GitHub App</strong> there and GitHub sends you back; the
        credentials are saved, encrypted.{" "}
        {tenancy === "single"
          ? "On a single-tenant instance the App is created private: it can only be installed on the account that owns it."
          : "On a multi-tenant instance the App is created public, so any account can install it."}
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-name`}>Name of the App</Label>
        <Input
          id={`${ids}-name`}
          type="text"
          autoComplete="off"
          maxLength={34}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={issueFor("name") !== undefined}
          aria-describedby={issueFor("name") ? `${ids}-name-error` : undefined}
        />
        {error("name")}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${ids}-organization`}>Organization (optional)</Label>
        <Input
          id={`${ids}-organization`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="Leave empty to create it under your own account"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
          aria-invalid={issueFor("organization") !== undefined}
          aria-describedby={
            issueFor("organization") ? `${ids}-organization-error` : undefined
          }
        />
        {error("organization")}
      </div>
      {configured ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={replace}
            onChange={(event) => setReplace(event.target.checked)}
          />
          <span>
            Replace the App that is configured now. Installations of the old App
            stop working here.
          </span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={pending}
          loadingLabel="Opening GitHub"
          disabled={configured && !replace}
        >
          Create GitHub App
        </Button>
        {failure !== null ? (
          <span role="alert" className="text-sm text-destructive">
            {failure.text}
          </span>
        ) : (
          <span role="status" />
        )}
      </div>
    </form>
  );
}
