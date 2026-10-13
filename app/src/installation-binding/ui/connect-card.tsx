// SPDX-License-Identifier: Apache-2.0

"use client";
// The Connect card of the Connections page (#176): one primary action (Connect GitHub) and one
// secondary (Link an existing installation, only while the list can be offered). When GitHub cannot
// prove who owns an account, the reason is one Alert — never a stack of sentences. The list of
// installations the person may choose from and the "how it works" explanation live here too. Account
// names come from GitHub: text, truncated, never markup.
import { useId } from "react";
import { Button } from "../../components/button.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import type { ConnectAvailability } from "../service.ts";
import type { ConnectionsPageData } from "./connections-page.tsx";
import { AVAILABILITY_COPY, CONNECT_HELP_COPY } from "./messages.ts";

/** The quiet tone of the one reason Alert: a hard block is a warning, an approval note is info. */
function reasonVariant(
  connect: Exclude<ConnectAvailability, "available">,
): "warning" | "info" {
  return connect === "needs_approval" ? "info" : "warning";
}

export function ConnectCard({
  connect,
  picker,
  choices,
  busy,
  onConnect,
  onStartPicker,
  onChoose,
}: {
  connect: ConnectAvailability;
  /** Whether the list of installations can be offered. */
  picker: boolean;
  /** The installations to choose from, or null while no list is open. */
  choices: ConnectionsPageData["choices"];
  busy: boolean;
  onConnect: () => void;
  onStartPicker: () => void;
  onChoose: (picker: string, installationId: string) => void;
}) {
  const titleId = useId();
  const blocked = connect !== "available" && connect !== "needs_approval";
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle>
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            Connect
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {connect === "available" ? null : (
          <Alert variant={reasonVariant(connect)} role="note">
            <AlertDescription>{AVAILABILITY_COPY[connect]}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || blocked} onClick={onConnect}>
            Connect GitHub
          </Button>
          {picker ? (
            <Button variant="secondary" disabled={busy} onClick={onStartPicker}>
              Link an existing installation
            </Button>
          ) : null}
        </div>

        {choices !== null ? (
          choices.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              GitHub shows no installation that you can use and that is not
              connected to a workspace yet.
            </p>
          ) : (
            <ul
              aria-label="Installations you can link"
              className="flex flex-col divide-y divide-border rounded-lg border border-border"
            >
              {choices.entries.map((entry) => (
                <li
                  key={entry.installationId}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 p-4"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {entry.accountLogin}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {entry.accountType === "Organization"
                        ? "Organization"
                        : "Personal account"}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Link ${entry.accountLogin}`}
                    onClick={() =>
                      onChoose(choices.picker, entry.installationId)
                    }
                  >
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}

        <HelpDisclosure label="What connecting GitHub does">
          <p>{CONNECT_HELP_COPY}</p>
        </HelpDisclosure>
      </CardContent>
    </Card>
  );
}
