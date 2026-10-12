// SPDX-License-Identifier: Apache-2.0

"use client";
// The ways to sign in: email with password and GitHub. At least one stays on; GitHub only when it is
// configured; GitHub as the only way needs your own linked GitHub account. The server judges every
// change (src/admin/sign-in-methods.ts); the form shows what is not possible and why.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import type { AdminSettingsView } from "../service.ts";
import type { AdminApi } from "./api.ts";
import { LastChanged } from "./last-changed.tsx";
import { SaveResult, useSave } from "./use-save.tsx";

export function SignInMethodsForm({
  settings,
  api,
}: {
  settings: AdminSettingsView;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const ids = useId();
  const [emailPassword, setEmailPassword] = useState(
    settings.signInMethods.effective.emailPassword,
  );
  const [github, setGithub] = useState(settings.signInMethods.effective.github);
  const { pending, status, save } = useSave(api);

  function submit(event: FormEvent) {
    event.preventDefault();
    void save({ signInMethods: { emailPassword, github } });
  }

  return (
    <form onSubmit={submit} className="settings-form" aria-labelledby={ids}>
      <h2 id={ids}>Ways to sign in</h2>
      <fieldset className="setup-options">
        <legend className="sr-only">Ways to sign in</legend>
        <label className="setup-option">
          <input
            type="checkbox"
            checked={emailPassword}
            onChange={(event) => setEmailPassword(event.target.checked)}
          />
          <span>
            <strong>Email with password</strong>
            <span className="muted">
              The admin account always signs in this way unless you switch it
              off.
            </span>
          </span>
        </label>
        <label className="setup-option">
          <input
            type="checkbox"
            checked={github}
            disabled={!settings.githubConfigured}
            onChange={(event) => setGithub(event.target.checked)}
          />
          <span>
            <strong>GitHub</strong>
            <span className="muted">
              {settings.githubConfigured
                ? "Sign in with the GitHub App. Switch email with password off to make this the only way, which needs your own GitHub account linked to this admin account."
                : "Not available: set up the GitHub App and enable its sign-in under Integrations first."}
            </span>
          </span>
        </label>
      </fieldset>
      <p className="muted small">
        Switching a way off does not sign anybody out: people who are signed in
        stay signed in until their session ends or they sign out.
      </p>
      <LastChanged setting={settings.signInMethods} />
      <div className="form-actions">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save ways to sign in"}
        </Button>
        <SaveResult status={status} />
      </div>
    </form>
  );
}
