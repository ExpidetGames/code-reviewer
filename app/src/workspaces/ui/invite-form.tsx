// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The form that invites a person: an email address and a role (an Owner offers all three, an Admin only
// Member). The role help sits in one tooltip next to the label, reachable with the keyboard (#177). Without
// a mail server the answer holds the link, which is shown once to be copied; with one the link was mailed
// and is not shown. The page keeps nothing of the link after the next invitation or a reload.
import { useProductIdentity } from "../../product-identity/context.tsx";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/button.tsx";
import { InfoHint } from "../../components/info-hint.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { Field, FieldLabel } from "../../components/ui/field.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import { canInviteAs } from "../permissions.ts";
import {
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "../../db/workspace-roles.ts";
import { browserWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { InvitationLink, type ShownInvitation } from "./invitation-link.tsx";
import { describeWorkspaceFailure } from "./messages.ts";
import { ROLE_HELP, ROLE_LABEL } from "./role-copy.ts";

export function InviteForm({
  workspaceSlug,
  viewerRole,
  api = browserWorkspaceApi(workspaceSlug),
}: {
  workspaceSlug: string;
  viewerRole: WorkspaceRole;
  /** Only tests pass this. */
  api?: WorkspaceApi;
}) {
  const product = useProductIdentity();
  const router = useRouter();
  const ids = useId();
  const roleId = `${ids}-role`;
  const emailId = `${ids}-email`;
  const errorId = `${ids}-error`;
  const emailRef = useRef<HTMLInputElement>(null);
  // Set in the submit handler, read after the render that shows the refusal, so the focus lands on the
  // address once the disabled fieldset is enabled again (R20, "focus the first error").
  const focusEmail = useRef(false);
  useEffect(() => {
    if (!focusEmail.current) return;
    focusEmail.current = false;
    emailRef.current?.focus();
  });
  const roles = WORKSPACE_ROLES.filter((role) => canInviteAs(viewerRole, role));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>(roles.at(-1) ?? "member");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownInvitation | null>(null);

  if (roles.length === 0) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    setShown(null);
    setPending(true);
    const result = await api.invite(email, role);
    setPending(false);
    if (!result.ok) {
      // R20: the address is the field a refusal is about, so it takes the focus back once shown.
      focusEmail.current = true;
      setProblem(describeWorkspaceFailure(product, result.code));
      return;
    }
    setShown({
      email: result.data.invitation.email,
      delivery: result.data.delivery,
    });
    setEmail("");
    router.refresh();
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4"
      aria-label="Invite a person"
    >
      {/* One row on a wide screen (address, role, send), as on the design board (#633). */}
      <fieldset
        disabled={pending}
        className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end md:gap-3"
      >
        {problem !== null ? (
          <Alert
            variant="destructive"
            id={errorId}
            className="md:col-span-full"
          >
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}
        <Field>
          <FieldLabel htmlFor={emailId}>Email address</FieldLabel>
          <Input
            ref={emailRef}
            id={emailId}
            type="email"
            autoComplete="off"
            required
            value={email}
            aria-describedby={problem !== null ? errorId : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          {/* As high as the other labels of the row: the 44px "?" target overflows it. */}
          <div className="flex h-5 items-center gap-1">
            <FieldLabel htmlFor={roleId}>Role</FieldLabel>
            <InfoHint label="About the roles">
              <span className="flex flex-col gap-1">
                {roles.map((candidate) => (
                  <span key={candidate}>
                    <strong>{ROLE_LABEL[candidate]}</strong>{" "}
                    {ROLE_HELP[candidate]}
                  </span>
                ))}
              </span>
            </InfoHint>
          </div>
          <Select
            value={role}
            onValueChange={(value) => setRole(value as WorkspaceRole)}
          >
            <SelectTrigger id={roleId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {ROLE_LABEL[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex justify-start">
          <Button type="submit" loading={pending} loadingLabel="Inviting">
            Send invitation
          </Button>
        </div>
      </fieldset>
      {shown !== null ? <InvitationLink shown={shown} /> : null}
    </form>
  );
}
