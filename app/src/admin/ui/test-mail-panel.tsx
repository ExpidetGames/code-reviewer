// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The "Send test mail" card: one mail to the admin's own address with the saved settings, and what the
// result was, in words. A failure shows its class (the sentence of messages.ts) and the detail the server
// sends back as plain text; the password is in neither, and the page never has it. The result is announced
// through the polite StatusRegion (#184-T03), so a screen reader hears it without losing focus.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
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
  const product = useProductIdentity();
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
        text: describeAdminFailure(product, result.code),
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
    <Card role="region" aria-labelledby="test-mail-heading">
      <CardHeader>
        <CardTitle>
          <h2
            id="test-mail-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Test mail
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Sends one message to {adminEmail} with the saved settings, so you see
          whether they work. Save your changes first.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={pending}
            loadingLabel="Sending the test mail"
            disabled={!configured}
            onClick={() => void send()}
          >
            Send test mail
          </Button>
          {configured ? null : (
            <span className="text-sm text-muted-foreground">
              Save a mail server first.
            </span>
          )}
        </div>
        <StatusRegion>
          {outcome?.kind === "sent" ? (
            <Alert variant="success" role="note">
              <AlertDescription>
                The test mail was handed to the mail server. Check the inbox of{" "}
                {adminEmail}.
              </AlertDescription>
            </Alert>
          ) : null}
          {outcome?.kind === "failed" ? (
            <Alert variant="destructive" role="note">
              <AlertDescription>
                {outcome.text}
                {outcome.detail === null ? null : (
                  <span className="block">
                    Detail: <span className="font-mono">{outcome.detail}</span>
                  </span>
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </StatusRegion>
      </CardContent>
    </Card>
  );
}
