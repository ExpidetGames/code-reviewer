// SPDX-License-Identifier: Apache-2.0

// The installation that the journey of the update (e2e/upgrade/) starts from: five people who signed in with
// GitHub before accounts existed, one connection to a GitHub installation with two repositories (one with an
// active project and two finished reviews), and the allow list of the previous release. Plain data, shared
// by the journey and the helper that makes the database.
import type { LegacySeed } from "../../src/test-support/legacy-installation";

/** The GitHub organization of the allow list and of the installation. */
export const UPGRADE_ORG = { login: "upgrade-org", id: 7790001 } as const;
export const UPGRADE_INSTALLATION_ID = 9700001;
export const UPGRADE_WIDGETS = {
  id: 9800001,
  fullName: "upgrade-org/widgets",
};
export const UPGRADE_GADGETS = {
  id: 9800002,
  fullName: "upgrade-org/gadgets",
};

export type UpgradePerson = {
  id: number;
  login: string;
  name: string;
  email: string;
  /** Listed in `ALLOWED_GITHUB_LOGINS`. */
  listed: boolean;
  /** A member of the allowed organization at GitHub. */
  inOrganization: boolean;
  /** The token of the last sign in is stored with another master key, so it cannot be read. */
  unreadableToken?: boolean;
  /** The login is bound to the account's id in the earlier release's `allowed_login_pins`. */
  pinned?: boolean;
};

/** In the order they signed in for the first time: the first who passes is the Owner. */
export const UPGRADE_PEOPLE: UpgradePerson[] = [
  {
    id: 7700001,
    login: "upgrade-alice",
    name: "Upgrade Alice",
    email: "upgrade-alice@example.test",
    listed: true,
    inOrganization: false,
    pinned: true,
  },
  {
    id: 7700002,
    login: "upgrade-bob",
    name: "Upgrade Bob",
    email: "upgrade-bob@example.test",
    listed: false,
    inOrganization: true,
  },
  {
    id: 7700003,
    login: "upgrade-carol",
    name: "Upgrade Carol",
    email: "upgrade-carol@example.test",
    listed: true,
    inOrganization: false,
  },
  {
    id: 7700004,
    login: "upgrade-dave",
    name: "Upgrade Dave",
    email: "upgrade-dave@example.test",
    listed: false,
    inOrganization: false,
  },
  {
    id: 7700005,
    login: "upgrade-erin",
    name: "Upgrade Erin",
    email: "upgrade-erin@example.test",
    listed: false,
    inOrganization: true,
    unreadableToken: true,
  },
];

/** A login on the list that nobody signed in with. */
export const NEVER_SIGNED_IN = "upgrade-zed";

export function allowedLogins(): string {
  return [
    ...UPGRADE_PEOPLE.filter((person) => person.listed).map(
      (person) => person.login,
    ),
    NEVER_SIGNED_IN,
  ].join(",");
}

/** The seed of the database, once the tokens of the earlier sign ins are known (login to token). */
export function upgradeSeed(
  secret: string,
  tokens: Record<string, string>,
): LegacySeed {
  return {
    secret,
    users: UPGRADE_PEOPLE.map((person, index) => ({
      login: person.login,
      githubId: person.id,
      createdAt: new Date(Date.UTC(2026, 8, 1 + index, 10)).toISOString(),
      // No address: the earlier sign in left the placeholder of GitHub, the new one replaces it.
      token: tokens[person.login] ?? null,
      tokenFromAnotherSecret: person.unreadableToken === true,
    })),
    pins: UPGRADE_PEOPLE.filter((person) => person.pinned === true).map(
      (person) => ({ login: person.login, githubId: person.id }),
    ),
    installations: [
      {
        id: UPGRADE_INSTALLATION_ID,
        accountLogin: UPGRADE_ORG.login,
        accountId: UPGRADE_ORG.id,
        repositories: [{ ...UPGRADE_WIDGETS, project: true }, UPGRADE_GADGETS],
      },
    ],
  };
}
