// SPDX-License-Identifier: Apache-2.0

"use client";
// "Link my GitHub account": starts GitHub's authorization of the signed-in person (the user authorization
// of the instance's GitHub App). Coming back, the identity is linked to this account, or, for the instance
// admin and an imported operator who has that identity and no other credential, the two accounts are merged
// (docs/decisions/0001-editions-setup-and-accounts.md, section 2.5). Used on the account page and in the
// admin portal; they differ only in the route they call. It renders the content of a normal card (the caller
// owns the card and its title), not a settings form, and the long merge explanation sits behind a disclosure.
import { useState } from "react";
import { Button } from "../../components/button.tsx";
import { HelpDisclosure } from "../../components/help-disclosure.tsx";
import { Alert, AlertDescription } from "../../components/ui/alert.tsx";
import { requestJson, type RequestResult } from "../../ui/json-request.ts";
import { goTo } from "./api.ts";
import { describeGithubFailure } from "./messages.ts";

export type StartLink = () => Promise<RequestResult<{ ok: true; url: string }>>;

/** The route that starts the linking, by the page it is started from. */
const START_ROUTE = {
  account: "/api/account/github/link",
  admin: "/api/admin/github/link",
} as const;

export function startLinkFrom(surface: "account" | "admin"): StartLink {
  return () =>
    requestJson(
      (url, init) => fetch(url, init),
      "POST",
      START_ROUTE[surface],
      {},
    );
}

export function LinkPanel({
  surface,
  startLink = startLinkFrom(surface),
  available,
  unavailableReason,
  merge = false,
  go = goTo,
}: {
  /** The page it is on: it decides the route that is called and where the person lands afterwards. */
  surface: "account" | "admin";
  /** Only tests pass this. */
  startLink?: StartLink;
  /** False while the GitHub App's user authorization is not configured. */
  available: boolean;
  unavailableReason?: string;
  /** Tell the admin about the merge with an imported operator. */
  merge?: boolean;
  /** Only tests pass this. */
  go?: (url: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setFailure(null);
    const result = await startLink();
    if (!result.ok) {
      setPending(false);
      setFailure(describeGithubFailure(result.code));
      return;
    }
    go(result.data.url);
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">
        GitHub asks you to authorize the App; no email address is compared.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          loading={pending}
          loadingLabel="Opening GitHub"
          disabled={!available}
          onClick={() => void start()}
        >
          Link GitHub account
        </Button>
        {!available && unavailableReason !== undefined ? (
          <span className="text-sm text-muted-foreground">
            {unavailableReason}
          </span>
        ) : null}
      </div>
      {failure !== null ? (
        <Alert variant="destructive" className="w-full">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      {merge ? (
        <HelpDisclosure label="What merging does">
          If you ran this instance before accounts existed and your GitHub
          account is an imported user here, the two accounts are merged: its
          memberships and history become yours, the higher role wins where you
          are both members, and the imported user is retired. That cannot be
          undone.
        </HelpDisclosure>
      ) : null}
    </div>
  );
}
