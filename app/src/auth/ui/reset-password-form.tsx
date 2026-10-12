// SPDX-License-Identifier: Apache-2.0

"use client";
// The form behind a password reset link: the new password twice. The server judges the password (the
// password rule of every account, stated once as an InfoHint) and the token; this form collects them and
// shows the reasons. The token comes from the link and is sent as it is; it is never shown or kept. A link
// that does not work says what happened and the next step, the detail behind a disclosure (#170).
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.tsx";
import { Field, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import { CROSS_SITE_REQUEST } from "../../copy/messages.ts";
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
  PASSWORD_RULE_HINT,
  PASSWORDS_DO_NOT_MATCH,
  type PasswordErrorCode,
} from "../password-policy.ts";

const FAILURE_COPY: Record<string, string> = {
  rate_limited:
    "Too many attempts in a short time. Wait a minute and try again.",
  cross_site_request: CROSS_SITE_REQUEST,
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
  const [invalidLink, setInvalidLink] = useState(false);
  const [done, setDone] = useState(false);

  if (token === null)
    return (
      <Alert variant="destructive">
        <AlertTitle>This link is incomplete.</AlertTitle>
        <AlertDescription>
          Ask for a new link on the sign-in page.
        </AlertDescription>
      </Alert>
    );

  if (done)
    return (
      <>
        <Alert variant="success" role="status">
          <AlertDescription>
            The password was changed and every session of this account was
            ended.
          </AlertDescription>
        </Alert>
        <Link href="/login">Sign in</Link>
      </>
    );

  if (invalidLink)
    return (
      <>
        <Alert variant="destructive">
          <AlertTitle>This link no longer works.</AlertTitle>
          <AlertDescription>
            Ask for a new link on the sign-in page.
          </AlertDescription>
        </Alert>
        <HelpDisclosure label="Why links stop working">
          A reset link works once and only for 30 minutes.
        </HelpDisclosure>
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
    if (result.code === "invalid_token") {
      setInvalidLink(true);
      return;
    }
    setProblem(describe(result.code, result.issues));
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-label="Set a new password"
    >
      {problem === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <Field>
        <div className="flex items-center gap-1">
          <FieldLabel htmlFor={`${ids}-password`}>New password</FieldLabel>
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
        loadingLabel="Saving the password"
      >
        Set the password
      </Button>
    </form>
  );
}
