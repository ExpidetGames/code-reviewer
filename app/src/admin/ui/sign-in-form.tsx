// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The ways to sign in (#181): email with password and GitHub, as one card with one form. At least one
// stays on; GitHub only while it is configured; GitHub as the only way needs the admin's own GitHub
// account linked. The server judges every change (src/admin/sign-in-methods.ts); the form shows what is
// not possible and why. Each switch's wrapper is a `<label for>` (the same 44px target as the project
// toggle, epic #165); a refused save moves focus to the control it is about (rulebook R20).
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
import { useFocusFirstError } from "./focus-first-error.tsx";
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
  const focusTargetRef = useFocusFirstError();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const [outcome] = await save({ signInMethods: { emailPassword, github } });
    // The refusal is about GitHub only when it can be switched on; otherwise the first switch.
    if (outcome?.kind === "failed")
      focusTargetRef.current =
        settings.githubConfigured && !github ? `${ids}-github` : `${ids}-email`;
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
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
            <label
              htmlFor={`${ids}-email`}
              className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
            >
              <Switch
                id={`${ids}-email`}
                checked={emailPassword}
                onCheckedChange={setEmailPassword}
                aria-describedby={`${ids}-email-hint`}
              />
            </label>
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
            <label
              htmlFor={`${ids}-github`}
              className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
            >
              <Switch
                id={`${ids}-github`}
                checked={github}
                onCheckedChange={setGithub}
                disabled={!settings.githubConfigured}
                aria-describedby={`${ids}-github-hint`}
              />
            </label>
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
