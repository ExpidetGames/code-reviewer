# Account

The page `/account` ("Account"): the signed-in person's address and the GitHub account linked to theirs.
Exactly two cards, Email and GitHub, each with one status badge and one line (#179). The long explanations
— the placeholder address of an imported user that could not be replaced because another account has
GitHub's verified address, and the merge of two accounts — sit behind a disclosure; the merge disclosure
is only rendered for the instance admin, the only person whose linking can merge
(`src/github-signin/link.ts`, docs/decisions/0001-editions-setup-and-accounts.md section 2.5). The GitHub
card hosts `src/github-config/ui/link-panel.tsx`, which is normal card content, not a settings form. Any
signed-in person who may use the app reaches it; the user menu links to it. `load.ts` reads what the page
shows, `ui/account-view.tsx` renders it.
