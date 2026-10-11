// SPDX-License-Identifier: Apache-2.0

"use client";
// Asks for a new verification link. The answer is the same for every address, and so is the copy.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { requestJson, type FetchLike } from "../../ui/json-request.ts";
import { describeSignUpFailure } from "./messages.ts";

export function ResendForm({
  initialEmail = "",
  fetchImpl = (url, init) => fetch(url, init),
}: {
  /** The address to start with (the signed in person's own), or empty. */
  initialEmail?: string;
  /** Only tests pass this. */
  fetchImpl?: FetchLike;
}) {
  const id = useId();
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setSent(false);
    setPending(true);
    const result = await requestJson<{ ok: true }>(
      fetchImpl,
      "POST",
      "/api/verify-email/resend",
      { email },
    );
    setPending(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    setProblem(describeSignUpFailure(result.code, result.issues));
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="login-form">
      {problem ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      {sent ? (
        <p role="status" className="alert alert-success">
          If this address is waiting to be confirmed, a new link is on its way.
          The older link no longer works.
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={id} className="field-label">
          Email address
        </label>
        <input
          id={id}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        variant="secondary"
        className="btn-block"
        disabled={pending}
      >
        {pending ? "Sending..." : "Send a new link"}
      </Button>
    </form>
  );
}
