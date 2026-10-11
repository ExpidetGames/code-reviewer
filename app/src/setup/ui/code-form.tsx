"use client";
// The form that asks for the setup code (what every page shows while the instance is not set up and
// the visitor has no setup session). The code is in the log of the app; it is never shown here.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { browserSetupApi, type SetupApi } from "./api.ts";
import { describeSetupFailure } from "./messages.ts";

export function CodeForm({
  existingInstallation = false,
  api = browserSetupApi,
  onAccepted = () => window.location.reload(),
}: {
  /** The instance has data from before the setup existed. */
  existingInstallation?: boolean;
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
      setProblem(describeSetupFailure(result.code));
      return;
    }
    onAccepted();
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="setup-form">
      <h1>Set up Code Reviewer</h1>
      <p>
        Enter the setup code to prove that you have access to this server. The
        app printed it in its log when it started; look for the line{" "}
        <code>Setup code:</code>. With Docker Compose:{" "}
        <code>docker compose logs app</code>.
      </p>
      {existingInstallation ? (
        <p className="alert alert-warning">
          This instance has data from before the setup existed. It is kept, and
          reviews keep running while you set up.
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={inputId} className="field-label">
          Setup code
        </label>
        <input
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
          className="setup-code-input"
        />
      </div>
      {problem === null ? null : (
        <p id={`${inputId}-error`} role="alert" className="alert alert-error">
          {problem}
        </p>
      )}
      <Button type="submit" disabled={pending || code.trim().length !== 6}>
        {pending ? "Checking..." : "Continue"}
      </Button>
    </form>
  );
}
