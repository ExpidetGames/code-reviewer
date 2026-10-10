# Code Reviewer

Automatic code reviews for GitHub pull requests, powered by [PR-Agent](https://github.com/qodo-ai/pr-agent), with a small web UI.

Code Reviewer wraps PR-Agent: it runs PR-Agent against pull requests and adds a web UI for configuring and inspecting reviews.

**Status:** in development.

## Branching

- `main` and `development` are permanent branches. `development` is the default branch.
- Epic branches start with the epic's ticket key and branch off `development`, e.g. `CR-2-foundation`.
- Ticket branches start with the ticket key and branch off their epic branch, e.g. `CR-14-repo-skeleton`.

Pull requests flow upwards:

1. Ticket branch -> PR into its epic branch.
2. Epic branch -> PR into `development`.
3. `development` -> PR into `main` for releases.

Direct pushes to `main` and `development` are not allowed; all changes go through pull requests.
