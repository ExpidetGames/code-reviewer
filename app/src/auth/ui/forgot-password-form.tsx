// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Asks for a password reset link by mail. The answer is the same for every address, and so is the copy: it
// never says whether the address has an account. A successful request leaves one success card instead of
// the form (#170).
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Field, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  CROSS_SITE_REQUEST,
  INVALID_EMAIL,
  UNAVAILABLE,
} from "../../copy/messages.ts";
import { requestJson, type FetchLike } from "../../ui/json-request.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";

const FAILURE_COPY: Record<string, string> = {
  invalid_input: INVALID_EMAIL,
  rate_limited:
    "Too many requests for this address. Wait a while and try again.",
  not_available:
    "Resetting a password by mail is not available on this instance. Ask the operator.",
  unavailable: UNAVAILABLE,
  cross_site_request: CROSS_SITE_REQUEST,
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

  if (sent)
    return (
      <Alert variant="success" role="status">
        <AlertDescription>
          Check your inbox. If this address has an account that signs in with a
          password, we sent it a link to choose a new password.
        </AlertDescription>
      </Alert>
    );

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-label="Request a reset link"
    >
      {problem === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor={id}>Email address</FieldLabel>
        <Input
          id={id}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Button type="submit" loading={pending} loadingLabel="Sending the link">
        Send me a link
      </Button>
    </form>
  );
}
