// SPDX-License-Identifier: Apache-2.0

"use client";
// What the person who invited is told about the link: it was mailed, or (no mail server, or the mail server
// refused the message) here it is, once, to copy and send. The link is a secret: it is in this component's
// state and in nothing else, it is not stored anywhere, and a new link needs a revoke and a new invitation
// (or, with a mail server, a resend).
import { useId, useState } from "react";
import { Button } from "../../ui/button.tsx";
import type { InvitationDelivery } from "../invitations.ts";

export type ShownInvitation = { email: string; delivery: InvitationDelivery };

export function InvitationLink({ shown }: { shown: ShownInvitation }) {
  const id = useId();
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const { delivery } = shown;

  if (delivery.kind === "mailed")
    return (
      <p role="status" className="alert alert-success">
        The invitation was sent to {shown.email}. The link works once and for 7
        days.
      </p>
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
    <div role="status" className="alert alert-warning">
      <p>
        {delivery.reason === "no_mail_server"
          ? `This instance cannot send mail. Send this link to ${shown.email} yourself.`
          : `The mail server did not accept the message. Send this link to ${shown.email} yourself, or revoke the invitation and try again.`}{" "}
        It is shown only now and works once, for 7 days, for that address.
      </p>
      <div className="field">
        <label htmlFor={id} className="field-label">
          Invitation link
        </label>
        <input
          id={id}
          type="text"
          readOnly
          value={delivery.link}
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      <div className="form-actions">
        <Button variant="secondary" onClick={() => void copy()}>
          Copy the link
        </Button>
        {copied === "yes" ? <span>Copied.</span> : null}
        {copied === "failed" ? (
          <span>Copying did not work: select the link and copy it.</span>
        ) : null}
      </div>
    </div>
  );
}
