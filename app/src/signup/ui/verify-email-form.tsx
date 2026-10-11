// SPDX-License-Identifier: Apache-2.0

"use client";
// The page behind a verification link: the password of the sign-up that made the link, and a button. The
// link only opens this page; the address is verified by the click, a POST, together with the password (the
// link is bound to it: somebody who clicks a link from another person's sign-up cannot complete it). A mail scanner or a link preview that opens every link in a message would
// otherwise use the link up before the person does. The token comes from the link and is sent as it is; it
// is never shown or kept.
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
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
      <>
        <p role="status" className="alert alert-success">
          Your email address is confirmed.
        </p>
        <Link href="/login">Sign in</Link>
      </>
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
      className="login-form"
      aria-label="Confirm email address"
    >
      {problem ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      <p>
        Confirm that this email address is yours. Enter the password you chose
        when you signed up with this link.
      </p>
      <div className="field">
        <label htmlFor={id} className="field-label">
          Password
        </label>
        <input
          id={id}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <Button type="submit" className="btn-block" disabled={pending}>
        {pending ? "Confirming..." : "Confirm email address"}
      </Button>
      {problem ? <Link href="/verify-email">Ask for a new link</Link> : null}
    </form>
  );
}
