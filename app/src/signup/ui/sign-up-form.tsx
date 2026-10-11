// SPDX-License-Identifier: Apache-2.0

"use client";
// The sign-up form: an email address and a password (the password rule of every account, which the server
// judges and the form states). The answer is the same whether or not the address may sign up, so the page
// says what happens next in words that are true either way: with a mail server a link is sent to the
// address if it may sign up, without one the person signs in.
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../../auth/password-policy.ts";
import { Button } from "../../ui/button.tsx";
import { requestJson, type FetchLike } from "../../ui/json-request.ts";
import { describeSignUpFailure } from "./messages.ts";

type Next = "verify_email" | "sign_in";

export function SignUpForm({
  fetchImpl = (url, init) => fetch(url, init),
}: {
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

  if (next === "verify_email")
    return (
      <>
        <p role="status" className="alert alert-success">
          Check your inbox. If this address may sign up, we sent it a link to
          confirm it. The account can be used once the address is confirmed.
        </p>
        <Link href="/verify-email">Did not get the email?</Link>
      </>
    );
  if (next === "sign_in")
    return (
      <>
        <p role="status" className="alert alert-success">
          Thank you. If this address may sign up, the account is ready: sign in
          with it.
        </p>
        <Link href="/login">Go to the sign-in</Link>
      </>
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    if (password !== repeat) {
      setProblem("The two passwords are not the same.");
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
    <form onSubmit={(event) => void submit(event)} className="login-form">
      {problem ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={`${ids}-email`} className="field-label">
          Email address
        </label>
        <input
          id={`${ids}-email`}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${ids}-password`} className="field-label">
          Password
        </label>
        <input
          id={`${ids}-password`}
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="muted small">
          At least {String(PASSWORD_MIN_LENGTH)} and at most{" "}
          {String(PASSWORD_MAX_LENGTH)} characters, and not a common password.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${ids}-repeat`} className="field-label">
          Repeat the password
        </label>
        <input
          id={`${ids}-repeat`}
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(event) => setRepeat(event.target.value)}
        />
      </div>
      <Button type="submit" className="btn-block" disabled={pending}>
        {pending ? "Creating..." : "Create account"}
      </Button>
    </form>
  );
}
