// SPDX-License-Identifier: Apache-2.0

"use client";
// The form that asks for the setup code (what every page shows while the instance is not set up and
// the visitor has no setup session). The code is in the log of the app; it is never shown here. The
// heading sits outside the form and the form carries an accessible name (#172).
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/button.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Field, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import { Input } from "@/components/ui/input.tsx";
import { browserSetupApi, type SetupApi } from "./api.ts";
import { describeSetupFailure, type SetupHosting } from "./messages.ts";

export function CodeForm({
  existingInstallation = false,
  hosting = "server",
  api = browserSetupApi,
  onAccepted = () => window.location.reload(),
}: {
  /** The instance has data from before the setup existed. */
  existingInstallation?: boolean;
  /** Where the code comes from: the log of a server, or `pnpm setup-code` of a serverless deployment. */
  hosting?: SetupHosting;
  /** Only tests pass these two. */
  api?: SetupApi;
  onAccepted?: () => void;
}) {
  const inputId = useId();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setProblem(null);
    const result = await api.submitCode(code.trim());
    setPending(false);
    if (!result.ok) {
      setProblem(describeSetupFailure(result.code, hosting));
      return;
    }
    onAccepted();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Set up Code Reviewer
        </h1>
        <p className="text-sm text-muted-foreground">
          {hosting === "serverless" ? (
            <>
              Enter the setup code that this command printed in your terminal:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
                pnpm setup-code
              </code>
            </>
          ) : (
            <>
              Enter the setup code from the app log:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
                docker compose logs app
              </code>
            </>
          )}
        </p>
      </div>
      {existingInstallation ? (
        <Alert variant="warning">
          <AlertDescription>
            The data from before the setup existed is kept, and reviews keep
            running while you set up.
          </AlertDescription>
        </Alert>
      ) : null}
      <form
        aria-label="Setup code"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <Field>
          <FieldLabel htmlFor={inputId}>Setup code</FieldLabel>
          <Input
            id={inputId}
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={problem !== null}
            aria-describedby={problem === null ? undefined : `${inputId}-error`}
            className="font-mono text-lg tracking-[0.4em]"
          />
          {problem === null ? null : (
            <FieldError id={`${inputId}-error`}>{problem}</FieldError>
          )}
        </Field>
        <div>
          <Button
            type="submit"
            loading={pending}
            disabled={code.trim().length !== 6}
          >
            {pending ? "Checking..." : "Continue"}
          </Button>
        </div>
      </form>
    </div>
  );
}
