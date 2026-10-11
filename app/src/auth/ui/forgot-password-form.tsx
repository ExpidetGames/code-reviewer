// SPDX-License-Identifier: Apache-2.0

"use client";
// Asks for a password reset link by mail. The answer is the same for every address, and so is the copy: it
// never says whether the address has an account.
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import { requestJson, type FetchLike } from "../../ui/json-request.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<string, string> = {
  invalid_input: "Enter a valid email address.",
  rate_limited: "Too many requests for this address. Wait a while and try again.",
  not_available:
    "Resetting a password by mail is not available on this instance. Ask the operator.",
  unavailable: "This is not available right now. Please try again later.",
  cross_site_request: "The request did not come from this page. Reload it.",
};

export function describeForgotPasswordFailure(code: string): string {
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

export function ForgotPasswordForm({
  fetchImpl = (url, init) => fetch(url, init),
}: {
  /** Only tests pass this. */
  fetchImpl?: FetchLike;
}) {
  const id = useId();
  const [email, setEmail] = useState("");
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
      "/api/password-reset/request",
      { email },
    );
    setPending(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    setProblem(describeForgotPasswordFailure(result.code));
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="login-form"
      aria-label="Request a reset link"
    >
      {problem ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      {sent ? (
        <p role="status" className="alert alert-success">
          Check your inbox. If this address has an account that signs in with a
          password, we sent it a link to choose a new password. The link works
          once and for 30 minutes.
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
      <Button type="submit" className="btn-block" disabled={pending}>
        {pending ? "Sending..." : "Send me a link"}
      </Button>
    </form>
  );
}
