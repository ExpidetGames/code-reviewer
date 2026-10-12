// SPDX-License-Identifier: Apache-2.0

"use client";
// The "Send test mail" button: one mail to the admin's own address with the saved settings, and what the
// result was, in words. A failure shows its class (the sentence of messages.ts) and the detail the server
// sends back as plain text; the password is in neither, and the page never has it.
import { useState } from "react";
import { Button } from "../../ui/button.tsx";
import { browserAdminApi, type AdminApi, type TestMailAnswer } from "./api.ts";
import { describeAdminFailure, describeTestMailFailure } from "./messages.ts";

type Outcome =
  | { kind: "sent" }
  | { kind: "failed"; text: string; detail: string | null }
  | null;

export function TestMailPanel({
  configured,
  adminEmail,
  api = browserAdminApi,
}: {
  /** Whether a mail server is saved. */
  configured: boolean;
  /** The address the test mail goes to. */
  adminEmail: string;
  /** Only tests pass this. */
  api?: AdminApi;
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function send() {
    setPending(true);
    setOutcome(null);
    const result = await api.testMail();
    setPending(false);
    if (!result.ok) {
      setOutcome({
        kind: "failed",
        text: describeAdminFailure(result.code),
        detail: null,
      });
      return;
    }
    const answer: TestMailAnswer = result.data;
    setOutcome(
      answer.ok
        ? { kind: "sent" }
        : {
            kind: "failed",
            text: describeTestMailFailure(answer.error),
            detail: answer.detail,
          },
    );
  }

  return (
    <section className="settings-form" aria-labelledby="test-mail-heading">
      <h2 id="test-mail-heading">Test mail</h2>
      <p className="muted">
        Sends one message to {adminEmail} with the saved settings, so you see
        whether they work. Save your changes first.
      </p>
      <div className="form-actions">
        <Button disabled={pending || !configured} onClick={() => void send()}>
          {pending ? "Sending..." : "Send test mail"}
        </Button>
        {!configured ? (
          <span className="muted small">Save a mail server first.</span>
        ) : null}
      </div>
      <div role="status" aria-live="polite">
        {outcome?.kind === "sent" ? (
          <p className="alert alert-success">
            The test mail was handed to the mail server. Check the inbox of{" "}
            {adminEmail}.
          </p>
        ) : null}
        {outcome?.kind === "failed" ? (
          <div className="alert alert-error" role="alert">
            <p>{outcome.text}</p>
            {outcome.detail !== null ? (
              <p className="muted small">
                Detail: <span className="mono">{outcome.detail}</span>
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
