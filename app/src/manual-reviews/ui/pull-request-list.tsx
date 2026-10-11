// The pull requests a person can pick from: one radio button per open pull request with number,
// title and author. Titles and names come from GitHub and are only ever rendered as text. With
// nothing open the list says so.
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
      <p className="muted" data-testid="no-open-pull-requests">
        There are no open pull requests in this repository. Open one on GitHub,
        then refresh the list.
      </p>
    );
  return (
    <fieldset className="pr-picker">
      <legend>Pull request</legend>
      <ul className="pr-list">
        {pullRequests.map((pr) => {
          const link = safeGithubUrl(pr.url);
          return (
            <li key={pr.number} className="pr-row">
              <label className="check-line">
                <input
                  type="radio"
                  name={name}
                  value={pr.number}
                  checked={selected === pr.number}
                  onChange={() => onSelect(pr.number)}
                />
                <span className="pr-number">#{pr.number}</span>{" "}
                <span className="pr-title">{pr.title}</span>{" "}
                <span className="muted small">by {pr.author}</span>{" "}
                {pr.draft ? <span className="badge">Draft</span> : null}
              </label>
              {link !== null ? (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="small"
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
