// SPDX-License-Identifier: Apache-2.0

// What a signed in person without a workspace sees (docs/decisions/0001-editions-setup-and-accounts.md,
// section 2.6), as a component over plain data so it is tested without a server:
//
// - the invitations that wait for their verified address (only with a mail server),
// - in a multi-tenant instance, the form that creates a workspace (they become its Owner),
// - in a single-tenant instance, the sentence "ask an admin of this instance for an invitation". Nothing
//   joins them automatically, however they got their account.
//
// Both instance modes render the action in the same card, so the slot is the same whether it holds the
// form or the sentence (#171).
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import type { PendingInvitation } from "../invitations.ts";
import type { AccountApi } from "./api.ts";
import { CreateWorkspaceForm } from "./create-workspace-form.tsx";
import { PendingInvitations } from "./pending-invitations.tsx";

export function NoAccessContent({
  multiTenant,
  pending,
  isInstanceAdmin,
  api,
  open,
}: {
  multiTenant: boolean;
  pending: PendingInvitation[];
  isInstanceAdmin: boolean;
  /** Only tests pass these two. */
  api?: AccountApi;
  open?: (path: string) => void;
}) {
  const withApi = {
    ...(api === undefined ? {} : { api }),
    ...(open === undefined ? {} : { open }),
  };
  return (
    <div className="flex flex-col gap-6">
      <PendingInvitations invitations={pending} {...withApi} />
      <Card>
        <CardContent>
          {multiTenant ? (
            <CreateWorkspaceForm {...withApi} />
          ) : (
            <p className="text-sm text-muted-foreground text-pretty">
              Ask an admin for an invitation.
            </p>
          )}
        </CardContent>
      </Card>
      {isInstanceAdmin ? (
        <p className="text-sm text-muted-foreground">
          You run code-review.com:{" "}
          <Link href="/admin" className="underline underline-offset-4">
            open the admin portal
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
