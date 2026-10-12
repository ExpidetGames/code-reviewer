// SPDX-License-Identifier: Apache-2.0

// What the project list shows while GitHub has given the workspace no repository: how to connect GitHub, in
// steps. A GitHub installation gives a workspace its repositories only once an Owner or Admin has connected it
// on the Connections page (docs/decisions/0001-editions-setup-and-accounts.md, section 2.9): installing the App
// on GitHub is not enough, so the steps go through that page.
import Link from "next/link";
import { EmptyState } from "../../ui/empty-state.tsx";

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
    <EmptyState
      title="No repositories yet"
      action={
        canConnect ? (
          <ol className="steps">
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
              &ldquo;Sync from GitHub&rdquo; reads them again if they do not.
            </li>
          </ol>
        ) : (
          <p className="muted">
            An Owner or Admin of the workspace connects GitHub on the{" "}
            <Link href={connectionsPath}>Connections</Link> page.
          </p>
        )
      }
    >
      The app can only see repositories of an installation that is connected to
      this workspace.
    </EmptyState>
  );
}
