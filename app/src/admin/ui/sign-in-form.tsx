// SPDX-License-Identifier: Apache-2.0

"use client";
// The ways to sign in (#181): email with password and GitHub, as one card with one form. At least one
// stays on; GitHub only while it is configured; GitHub as the only way needs the admin's own GitHub
// account linked. The server judges every change (src/admin/sign-in-methods.ts); the form shows what is
// not possible and why.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "../../components/ui/field.tsx";
import { Switch } from "../../components/ui/switch.tsx";
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
    <form
      onSubmit={submit}
      aria-label="Ways to sign in"
      className="flex max-w-[44rem] flex-col gap-6"
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-lg font-semibold tracking-tight">
              Ways to sign in
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Field orientation="horizontal" className="items-start">
            <span className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
              <Switch
                id={`${ids}-email`}
                checked={emailPassword}
                onCheckedChange={setEmailPassword}
                aria-describedby={`${ids}-email-hint`}
              />
            </span>
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor={`${ids}-email`}>
                Email with password
              </FieldLabel>
              <FieldDescription id={`${ids}-email-hint`}>
                The admin account always signs in this way unless you switch it
                off.
              </FieldDescription>
            </div>
          </Field>
          <Field orientation="horizontal" className="items-start">
            <span className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
              <Switch
                id={`${ids}-github`}
                checked={github}
                onCheckedChange={setGithub}
                disabled={!settings.githubConfigured}
                aria-describedby={`${ids}-github-hint`}
              />
            </span>
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor={`${ids}-github`}>GitHub</FieldLabel>
              <FieldDescription id={`${ids}-github-hint`}>
                {settings.githubConfigured
                  ? "Sign in with the GitHub App. Switch email with password off to make this the only way, which needs your own GitHub account linked to this admin account."
                  : "Not available: set up the GitHub App and enable its sign-in under Integrations first."}
              </FieldDescription>
            </div>
          </Field>
          <FieldDescription>
            Switching a way off does not sign anybody out: people who are signed
            in stay signed in until their session ends or they sign out.
          </FieldDescription>
          <LastChanged setting={settings.signInMethods} />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} loadingLabel="Saving">
          Save ways to sign in
        </Button>
        <SaveResult status={status} />
      </div>
    </form>
  );
}
