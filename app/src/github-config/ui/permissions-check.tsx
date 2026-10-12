// SPDX-License-Identifier: Apache-2.0

"use client";
// What an App that was imported or made by hand may lack: the account permission "Email addresses" (the
// verified primary email of a GitHub sign in) and the organization permission "Members" (a person's role
// when an installation is bound to a workspace). The list is always shown; the button asks GitHub which of
// them this App really lacks.
import { useId, useState } from "react";
import { Button } from "../../ui/button.tsx";
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
  const ids = useId();
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
    <section className="settings-form" aria-labelledby={ids}>
      <h3 id={ids}>Permissions of this App</h3>
      <p className="muted">
        An App that was imported or made by hand may lack two permissions that
        the one-click flow asks for. Add them in the App&apos;s settings on
        GitHub (Permissions &amp; events), then accept the changed permissions
        on each installation when GitHub asks:
      </p>
      <ul className="muted">
        <li>{PERMISSION_LABELS.emails}</li>
        <li>{PERMISSION_LABELS.members}</li>
      </ul>
      <div className="form-actions">
        <Button disabled={pending} onClick={() => void check()}>
          {pending ? "Asking GitHub..." : "Check the permissions"}
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {outcome?.kind === "missing" && outcome.missing.length === 0 ? (
          <p className="alert alert-success">
            The App has every permission Code Reviewer asks for.
          </p>
        ) : null}
        {outcome?.kind === "missing" && outcome.missing.length > 0 ? (
          <div className="alert alert-warning">
            <p>
              <strong>The App lacks:</strong>
            </p>
            <ul>
              {outcome.missing.map((name) => (
                <li key={name}>{PERMISSION_LABELS[name] ?? name}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {outcome?.kind === "failed" ? (
          <p className="alert alert-error" role="alert">
            {outcome.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
