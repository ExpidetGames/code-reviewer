// SPDX-License-Identifier: Apache-2.0

// The pull requests a person can pick from (#174): one radio button per open pull request with number,
// title and author, and the link to GitHub for the repositories whose address is allowed. Titles and
// names come from GitHub and are only ever rendered as text. With nothing open the list says so.
import { Badge } from "../../components/ui/badge.tsx";
import { safeGithubUrl } from "../../runs/run-view.ts";
import type { PullRequestChoice } from "../service.ts";

export function PullRequestList({
  pullRequests,
  selected,
  onSelect,
  name,
}: {
  pullRequests: readonly PullRequestChoice[];
  selected: number | null;
  onSelect: (number: number) => void;
  /** The shared `name` of the radio buttons. */
  name: string;
}) {
  if (pullRequests.length === 0)
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid="no-open-pull-requests"
      >
        There are no open pull requests in this repository. Open one on GitHub,
        then refresh the list.
      </p>
    );
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-sm font-medium">Pull request</legend>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {pullRequests.map((pr) => {
          const link = safeGithubUrl(pr.url);
          return (
            <li
              key={pr.number}
              className="flex items-center justify-between gap-3 border-t border-border py-2 first:border-t-0"
            >
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={name}
                  value={pr.number}
                  checked={selected === pr.number}
                  onChange={() => onSelect(pr.number)}
                  className="size-4 accent-primary"
                />
                <span className="text-muted-foreground">#{pr.number}</span>{" "}
                <span className="truncate font-medium text-foreground">
                  {pr.title}
                </span>{" "}
                <span className="shrink-0 text-muted-foreground">
                  by {pr.author}
                </span>{" "}
                {pr.draft ? <Badge variant="neutral">Draft</Badge> : null}
              </label>
              {link !== null ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-sm text-primary underline-offset-4 hover:underline"
                  aria-label={`Open pull request ${pr.number} on GitHub`}
                >
                  GitHub
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
