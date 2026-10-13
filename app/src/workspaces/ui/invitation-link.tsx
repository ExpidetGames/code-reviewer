// SPDX-License-Identifier: Apache-2.0

"use client";
// What the person who invited is told about the link (#177: two short lines and Copy): it was mailed, or
// (no mail server, or the mail server refused the message) here it is, once, to copy and send. The lifetime
// sentence comes from its one owner (`messages.ts`), so it is written in exactly one place. The link is a
// secret: it is in this component's state and in nothing else, it is not stored anywhere, and a new link
// needs a revoke and a new invitation (or, with a mail server, a resend).
import { useId, useState } from "react";
import { Button } from "../../components/button.tsx";
import { StatusRegion } from "../../components/status-region.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import type { InvitationDelivery } from "../invitations.ts";
import { INVITATION_LINK_LIFETIME } from "./messages.ts";

export type ShownInvitation = { email: string; delivery: InvitationDelivery };

export function InvitationLink({ shown }: { shown: ShownInvitation }) {
  const id = useId();
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const { delivery } = shown;

  if (delivery.kind === "mailed")
    return (
      <Alert variant="success" role="status">
        <AlertDescription>
          The invitation was sent to {shown.email}. {INVITATION_LINK_LIFETIME}
        </AlertDescription>
      </Alert>
    );

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        delivery.kind === "link" ? delivery.link : "",
      );
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <Alert variant="warning" role="status">
      <AlertDescription className="flex flex-col gap-3">
        <span>
          {delivery.reason === "no_mail_server"
            ? `This instance cannot send mail. Send this link to ${shown.email} yourself.`
            : `The mail server did not accept the message. Send this link to ${shown.email} yourself.`}{" "}
          {INVITATION_LINK_LIFETIME}
        </span>
        <span className="flex flex-col gap-2">
          <Label htmlFor={id}>Invitation link</Label>
          <Input
            id={id}
            type="text"
            readOnly
            value={delivery.link}
            onFocus={(event) => event.currentTarget.select()}
          />
        </span>
        <span className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void copy()}>
            Copy the link
          </Button>
          {copied === "yes" ? <StatusRegion>Copied.</StatusRegion> : null}
          {copied === "failed" ? (
            <StatusRegion>
              Copying did not work: select the link and copy it.
            </StatusRegion>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}
