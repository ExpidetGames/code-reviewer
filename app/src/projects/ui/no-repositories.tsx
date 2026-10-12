// SPDX-License-Identifier: Apache-2.0

// What the project list shows while GitHub has given the workspace no repository: one title, one
// sentence on what will appear here, and one primary action. The install walkthrough sits behind a
// disclosure instead of filling the empty state. A GitHub installation gives a workspace its
// repositories only once an Owner or Admin has connected it on the Connections page
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9): installing the App on GitHub is
// not enough, so the walkthrough goes through that page.
import Link from "next/link";
import { Button } from "../../components/button.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty.tsx";

export function NoRepositories({
  connectionsPath,
  canConnect,
}: {
  /** The Connections page of the workspace. */
  connectionsPath: string;
  /** Whether the person may connect GitHub (an Owner or Admin). */
  canConnect: boolean;
}) {
  return (
    <Empty className="border border-border bg-card">
      <EmptyHeader>
        <EmptyTitle>
          <h2>No repositories yet</h2>
        </EmptyTitle>
        <EmptyDescription>
          The app can only see repositories of an installation that is connected
          to this workspace.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {canConnect ? (
          <>
            <Button asChild variant="primary">
              <Link href={connectionsPath}>Connect GitHub</Link>
            </Button>
            <HelpDisclosure label="How to connect GitHub">
              <ol className="flex list-decimal flex-col gap-2 pl-5 text-left">
                <li>
                  Open <Link href={connectionsPath}>Connections</Link> and press
                  &ldquo;Connect GitHub&rdquo;.
                </li>
                <li>
                  On GitHub choose the account or organization that owns your
                  repositories, the repositories the app may read, and press
                  Install. You have to own the account or be an owner of the
                  organization.
                </li>
                <li>
                  GitHub brings you back, and the repositories show up here.
                  &ldquo;Sync from GitHub&rdquo; reads them again if they do
                  not.
                </li>
              </ol>
            </HelpDisclosure>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            An Owner or Admin of the workspace connects GitHub on the{" "}
            <Link href={connectionsPath}>Connections</Link> page.
          </p>
        )}
      </EmptyContent>
    </Empty>
  );
}
