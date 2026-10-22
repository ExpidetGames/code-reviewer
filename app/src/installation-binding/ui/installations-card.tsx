// SPDX-License-Identifier: Apache-2.0

"use client";
// The Installations card of the Connections page (#176): one compact row per GitHub installation
// linked to the workspace — the account, its type and how many of its repositories the workspace
// reviews, a status badge and, for an Owner or Admin, a Disconnect action. Disconnecting asks for
// confirmation in a dialog (the only destructive action of the page). The account name comes from
// GitHub: it is text, truncated, never markup. Status is not told by colour alone; the badge label
// carries the meaning and the variant is only the quiet tone.
import { useId } from "react";
import { Button } from "../../components/button.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import type { ConnectionView } from "./connections-page.tsx";

const STATUS_COPY: Record<ConnectionView["status"], string> = {
  active: "Connected",
  disabled: "Suspended on GitHub",
  disconnected: "Disconnected",
};

const STATUS_VARIANT: Record<
  ConnectionView["status"],
  "success" | "warning" | "neutral"
> = {
  active: "success",
  disabled: "warning",
  disconnected: "neutral",
};

/** How the account behind an installation is named. */
function accountTypeLabel(accountType: string): string {
  if (accountType === "Organization") return "Organization";
  if (accountType === "User") return "Personal account";
  return "Account";
}

/** The second line of a row: the account type and, while the connection is live, its repository count. */
function rowNote(connection: ConnectionView): string {
  const type = accountTypeLabel(connection.accountType);
  if (connection.status !== "active") return type;
  const count = connection.repositoryCount;
  return `${type}, ${String(count)} ${count === 1 ? "repository" : "repositories"}`;
}

export function InstallationsCard({
  connections,
  canManage,
  busy,
  onDisconnect,
}: {
  connections: ConnectionView[];
  /** Whether the person may disconnect (an Admin or an Owner). */
  canManage: boolean;
  /** A flow is in flight; every control is disabled so a double click cannot repeat it. */
  busy: boolean;
  onDisconnect: (integrationId: string) => void;
}) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle>
          <h2
            id={titleId}
            className="text-lg leading-7 font-semibold tracking-normal"
          >
            Installations
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No GitHub installation is connected yet.
          </p>
        ) : (
          <ul
            aria-label="Installations"
            className="flex flex-col divide-y divide-border"
          >
            {connections.map((connection) => (
              <li
                key={connection.id}
                data-connection={connection.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-4 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="min-w-0 truncate font-semibold text-foreground">
                    {connection.accountLogin}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {rowNote(connection)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={STATUS_VARIANT[connection.status]}>
                    {STATUS_COPY[connection.status]}
                  </Badge>
                  {canManage && connection.status !== "disconnected" ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          aria-label={`Disconnect ${connection.accountLogin}`}
                        >
                          Disconnect
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Disconnect{" "}
                            <span className="break-all">
                              {connection.accountLogin}
                            </span>
                            ?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            Projects and runs stay. Nothing changes on GitHub.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            disabled={busy}
                            aria-label={`Confirm disconnecting ${connection.accountLogin}`}
                            onClick={() => onDisconnect(connection.id)}
                          >
                            Disconnect
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
