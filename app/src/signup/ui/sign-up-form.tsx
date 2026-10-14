// SPDX-License-Identifier: Apache-2.0

"use client";
// The sign-up form: an email address and a password (the password rule of every account, which the server
// judges and the form states once, as an InfoHint from its single owner). The answer is the same whether or
// not the address may sign up, so the page says what happens next in words that are true either way: with a
// mail server a link is sent to the address if it may sign up, without one the person signs in. Both answers
// are one success card with a single link back to the sign-in (#170).
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import {
  PASSWORD_RULE_HINT,
  PASSWORDS_DO_NOT_MATCH,
} from "../../auth/password-policy.ts";
import { Button } from "../../components/button.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Field, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { requestJson, type FetchLike } from "../../ui/json-request.ts";
import { describeSignUpFailure } from "./messages.ts";

type Next = "verify_email" | "sign_in";

export function SignUpForm({
  signInPath = "/login",
  fetchImpl = (url, init) => fetch(url, init),
}: {
  /** Where "Back to sign in" leads: the login page, with an invitation link carried along. */
  signInPath?: string;
  /** Only tests pass this. */
  fetchImpl?: FetchLike;
}) {
  const ids = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [next, setNext] = useState<Next | null>(null);

  if (next !== null)
    return (
      <>
        <Alert variant="success" role="status">
          <AlertDescription>
            {next === "verify_email"
              ? "Check your inbox. If this address may sign up, we sent it a link to confirm it."
              : "If this address may sign up, the account is ready: sign in with your password."}
          </AlertDescription>
        </Alert>
        <Link
          className="text-sm underline underline-offset-4"
          href={signInPath}
        >
          Back to sign in
        </Link>
      </>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (password !== repeat) {
      setProblem(PASSWORDS_DO_NOT_MATCH);
      return;
    }
    setPending(true);
    const result = await requestJson<{ ok: true; next: Next }>(
      fetchImpl,
      "POST",
      "/api/sign-up",
      { email, password },
    );
    setPending(false);
    if (result.ok) {
      setNext(result.data.next === "verify_email" ? "verify_email" : "sign_in");
      return;
    }
    setProblem(describeSignUpFailure(result.code, result.issues));
  }

  return (
    <>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
        aria-label="Sign-up form"
      >
        {problem === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor={`${ids}-email`}>Email address</FieldLabel>
          <Input
            id={`${ids}-email`}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          <div className="flex items-center gap-1">
            <FieldLabel htmlFor={`${ids}-password`}>Password</FieldLabel>
            <InfoHint label="About the password rule">
              {PASSWORD_RULE_HINT}
            </InfoHint>
          </div>
          <Input
            id={`${ids}-password`}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-repeat`}>Repeat the password</FieldLabel>
          <Input
            id={`${ids}-repeat`}
            type="password"
            autoComplete="new-password"
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          loading={pending}
          loadingLabel="Creating your account"
        >
          Create account
        </Button>
      </form>
      <Link className="text-sm underline underline-offset-4" href={signInPath}>
        Back to sign in
      </Link>
    </>
  );
}
