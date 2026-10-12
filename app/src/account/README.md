# Account

The page `/account` ("Your account"): the signed-in person's address (with a hint when an imported user's placeholder
address could not be replaced because another account has GitHub's verified address), and the GitHub account linked
to theirs, with the button that links one (`src/github-signin/link.ts`). Any signed-in person who may use the app reaches
it; the user menu links to it. `load.ts` reads what the page shows, `ui/account-view.tsx` renders it.
