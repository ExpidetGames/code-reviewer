// SPDX-License-Identifier: Apache-2.0

"use client";
// The page behind a verification link: one button. The link only opens this page; the address is
// verified by the click, a POST. A mail scanner or a link preview that opens every link in a message would
// otherwise use the link up before the person does. The token comes from the link and is sent as it is; it
// is never shown or kept.
import Link from "next/link";
import { useState } from "react";
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

  async function confirm() {
    setProblem(null);
    setPending(true);
    const result = await requestJson<{ ok: true }>(
      fetchImpl,
      "POST",
      "/api/verify-email",
      { token },
    );
    setPending(false);
    if (result.ok) {
      setDone(true);
      return;
    }
    setProblem(describeSignUpFailure(result.code, result.issues));
  }

  return (
    <div className="login-form">
      {problem ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      <p>Confirm that this email address is yours.</p>
      <Button
        type="button"
        className="btn-block"
        disabled={pending}
        onClick={() => void confirm()}
      >
        {pending ? "Confirming..." : "Confirm email address"}
      </Button>
      {problem ? <Link href="/verify-email">Ask for a new link</Link> : null}
    </div>
  );
}
