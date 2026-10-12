// SPDX-License-Identifier: Apache-2.0

"use client";
// What an App that was imported or made by hand may lack: the account permission "Email addresses" (the
// verified primary email of a GitHub sign in) and the organization permission "Members" (a person's role
// when an installation is bound to a workspace). The list is always shown; the button asks GitHub which of
// them this App really lacks. It sits behind the "Permissions GitHub granted" disclosure of the page.
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { browserGithubApi, type GithubApi } from "./api.ts";
import { describeGithubFailure, PERMISSION_LABELS } from "./messages.ts";

type Outcome =
  | { kind: "missing"; missing: string[] }
  | { kind: "failed"; text: string }
  | null;

export function PermissionsCheck({
  api = browserGithubApi,
}: {
  /** Only tests pass this. */
  api?: GithubApi;
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function check() {
    setPending(true);
    setOutcome(null);
    const result = await api.check();
    setPending(false);
    setOutcome(
      result.ok
        ? { kind: "missing", missing: result.data.missing }
        : { kind: "failed", text: describeGithubFailure(result.code) },
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-2">
      <p className="text-sm text-muted-foreground">
        An App that was imported or made by hand may lack two permissions that
        the one-click flow asks for. Add them in the App&apos;s settings on
        GitHub (Permissions &amp; events), then accept the changed permissions
        on each installation when GitHub asks:
      </p>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">
        <li>{PERMISSION_LABELS.emails}</li>
        <li>{PERMISSION_LABELS.members}</li>
      </ul>
      <div>
        <Button
          loading={pending}
          loadingLabel="Asking GitHub"
          onClick={() => void check()}
        >
          Check the permissions
        </Button>
      </div>
      <div aria-live="polite">
        {outcome?.kind === "missing" && outcome.missing.length === 0 ? (
          <Alert variant="success">
            <AlertDescription>
              The App has every permission Code Reviewer asks for.
            </AlertDescription>
          </Alert>
        ) : null}
        {outcome?.kind === "missing" && outcome.missing.length > 0 ? (
          <Alert variant="warning">
            <AlertDescription>
              <p>The App lacks:</p>
              <ul className="list-disc pl-5">
                {outcome.missing.map((name) => (
                  <li key={name}>{PERMISSION_LABELS[name] ?? name}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        {outcome?.kind === "failed" ? (
          <Alert variant="destructive">
            <AlertDescription>{outcome.text}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
