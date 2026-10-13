// SPDX-License-Identifier: Apache-2.0

"use client";
// Asks for a new verification link. The answer is the same for every address, and so is the copy.
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/button";
import { StatusRegion } from "@/components/status-region";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-label="Request a new link"
    >
      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {sent ? (
        <StatusRegion className="text-success">
          If this address is waiting to be confirmed, a new link is on its way.
          It is used with the password of the sign-up it belongs to.
        </StatusRegion>
      ) : null}
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
      <Button
        type="submit"
        variant="secondary"
        loading={pending}
        loadingLabel="Sending"
        className="w-full"
      >
        Send a new link
      </Button>
    </form>
  );
}
