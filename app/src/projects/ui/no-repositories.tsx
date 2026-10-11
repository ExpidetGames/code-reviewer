// SPDX-License-Identifier: Apache-2.0

// What the project list shows while GitHub has given the app no repository: how to install the
// GitHub App, in steps, with the link to its installation page when the app's name is configured.
import { EmptyState } from "../../ui/empty-state.tsx";

export function NoRepositories({ installUrl }: { installUrl: string | null }) {
  return (
    <EmptyState
      title="No repositories yet"
      action={
        <ol className="steps">
          <li>
            {installUrl !== null ? (
              <>
                Open the{" "}
                <a href={installUrl} rel="noreferrer noopener" target="_blank">
                  GitHub App installation page
                </a>{" "}
                and choose the account or organization that owns your
                repositories.
              </>
            ) : (
              <>
                Install the GitHub App on the account or organization that owns
                your repositories. Its address is not configured yet
                (GITHUB_APP_SLUG), so ask the person who runs this instance.
              </>
            )}
          </li>
          <li>Choose the repositories it may read and press Install.</li>
          <li>
            Come back here and press &ldquo;Sync from GitHub&rdquo; if the
            repositories do not show up on their own.
          </li>
        </ol>
      }
    >
      The app can only see repositories it has been installed on.
    </EmptyState>
  );
}
