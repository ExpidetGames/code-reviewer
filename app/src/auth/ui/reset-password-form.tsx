// SPDX-License-Identifier: Apache-2.0

"use client";
// The form behind a password reset link: the new password twice. The server judges the password (the
// password rule of every account) and the token; this form collects them and shows the reasons. The token
// comes from the link and is sent as it is; it is never shown or kept.
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../ui/button.tsx";
import {
  requestJson,
  type FetchLike,
  type RequestIssue,
} from "../../ui/json-request.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import {
  PASSWORD_ERROR_COPY,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordErrorCode,
} from "../password-policy.ts";

const FAILURE_COPY: Record<string, string> = {
  invalid_token:
    "This link is not valid any more. It was used already, or it expired after 30 minutes, or it is not complete. Ask for a new one with \"Forgot your password?\" on the sign-in page (if this instance sends mail), or ask the operator of this instance, who can run `admin reset-password` on the server.",
  rate_limited:
    "Too many attempts in a short time. Wait a minute and try again.",
  cross_site_request: "The request did not come from this page. Reload it.",
};

function describe(code: string, issues: RequestIssue[]): string {
  const password = issues.find((issue) => issue.field === "password");
  if (password && Object.hasOwn(PASSWORD_ERROR_COPY, password.code))
    return PASSWORD_ERROR_COPY[password.code as PasswordErrorCode];
  return (
    describeTransportFailure(code) ??
    (Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined) ??
    GENERIC_FAILURE
  );
}

export function ResetPasswordForm({
  token,
  fetchImpl = (url, init) => fetch(url, init),
}: {
  /** The token from the link, or null when the link has none. */
  token: string | null;
  /** Only tests pass this. */
  fetchImpl?: FetchLike;
}) {
  const ids = useId();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (token === null)
    return (
      <p role="alert" className="alert alert-error">
        This link is incomplete: it has no token. Copy the whole link that
        `admin reset-password` printed.
      </p>
    );

  if (done)
    return (
      <>
        <p role="status" className="alert alert-success">
          The password was changed and every session of this account was ended.
        </p>
        <Link href="/login">Sign in</Link>
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
    const result = await requestJson<{ ok: true }>(
      fetchImpl,
      "POST",
      "/api/password-reset",
      { token, password },
    );
    setPending(false);
    if (result.ok) {
      setDone(true);
      return;
    }
    setProblem(describe(result.code, result.issues));
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="login-form">
      {problem ? (
        <p role="alert" className="alert alert-error">
          {problem}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={`${ids}-password`} className="field-label">
          New password
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
        {pending ? "Saving..." : "Set the password"}
      </Button>
    </form>
  );
}
