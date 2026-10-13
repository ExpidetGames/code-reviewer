// SPDX-License-Identifier: Apache-2.0

"use client";
// The page behind a verification link: the password of the sign-up that made the link, and a button. The
// link only opens this page; the address is verified by the click, a POST, together with the password (the
// link is bound to it: somebody who clicks a link from another person's sign-up cannot complete it). A mail scanner or a link preview that opens every link in a message would
// otherwise use the link up before the person does. The token comes from the link and is sent as it is; it
// is never shown or kept.
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/button";
import { StatusRegion } from "@/components/status-region";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { requestJson, type FetchLike } from "../../ui/json-request.ts";
import { describeSignUpFailure } from "./messages.ts";

export function VerifyEmailForm({
  token,
  fetchImpl = (url, init) => fetch(url, init),
}: {
  token: string;
  /** Only tests pass this. */
  fetchImpl?: FetchLike;
}) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done)
    return (
      <div className="flex flex-col gap-4">
        <StatusRegion className="text-success">
          Your email address is confirmed.
        </StatusRegion>
        <Link href="/login" className="underline underline-offset-4">
          Sign in
        </Link>
      </div>
    );

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setPending(true);
    const result = await requestJson<{ ok: true }>(
      fetchImpl,
      "POST",
      "/api/verify-email",
      { token, password },
    );
    setPending(false);
    if (result.ok) {
      setDone(true);
      return;
    }
    setProblem(describeSignUpFailure(result.code, result.issues));
  }

  return (
    <form
      onSubmit={(event) => void confirm(event)}
      className="flex flex-col gap-4"
      aria-label="Confirm email address"
    >
      {problem ? (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <Field>
        <FieldLabel htmlFor={id}>Password</FieldLabel>
        <Input
          id={id}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Button
        type="submit"
        loading={pending}
        loadingLabel="Confirming"
        className="w-full"
      >
        Confirm email address
      </Button>
      {problem ? <Link href="/verify-email">Ask for a new link</Link> : null}
    </form>
  );
}
