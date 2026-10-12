// SPDX-License-Identifier: Apache-2.0

// The GitHub Apps the fake knows about, shared by its parts: the one that was registered when the fake
// started (`appId`, `publicKeyPem`, `clientId`, `clientSecret`) and the ones created through the manifest
// flow (`manifest.ts`). The GitHub App API part checks App JWTs against the key of the app named in the
// token, the sign in part looks the client credentials up here, and `GET /app` describes the app.
// State is in memory. Dummy values only.

/** GitHub's permission names mapped to a level. */
export type FakeAppPermissionMap = Record<string, "read" | "write" | "admin">;

export type FakeRegisteredApp = {
  /** The numeric app id, as text. */
  id: string;
  slug: string;
  name: string;
  ownerLogin: string;
  /** The account id of the owner (what `GET /app` reports as `owner.id`). */
  ownerId: number;
  /** SPKI PEM of the app's key pair; absent for an app that only signs people in. */
  publicKeyPem: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  /** The repository permissions the app holds (what `GET /app` reports, together with the account ones). */
  permissions: FakeAppPermissionMap;
  /** Account and organization permissions (`emails`, `members`) the user tokens of this app hold. */
  accountPermissions: FakeAppPermissionMap;
  events: string[];
  /**
   * The callback URLs registered for the user authorization. A sign in whose `redirect_uri` is not one of
   * them is refused, like on GitHub. Null: the fake does not check (an app that was registered by hand
   * in a test).
   */
  callbackUrls: string[] | null;
  /** Whether the app can only be installed on its owner's account. */
  isPublic: boolean;
  /**
   * The "Setup URL" of the app: where GitHub sends the person after an installation. The manifest names it;
   * for the app registered at start a test says it (`setAppSetupUrl`). Null: the installation page cannot
   * send anybody anywhere and refuses.
   */
  setupUrl: string | null;
  /** Where the manifest sent the person after the creation, kept for tests. */
  createdFromManifest: boolean;
};

/** What an app registered at start is granted on the account level unless a test changes it. */
export const DEFAULT_ACCOUNT_PERMISSIONS: FakeAppPermissionMap = {
  emails: "read",
  members: "read",
};

/**
 * The account id the fake gives the owner of an app, by login: stable, and the same for the same login, so a test
 * can add an installation "on the app's own account" without asking the fake.
 */
export function ownerIdFor(login: string): number {
  let hash = 17;
  for (const character of login.toLowerCase())
    hash = (hash * 31 + character.charCodeAt(0)) % 900_000;
  return 100_000 + hash;
}

export type AppRegistry = {
  add(app: FakeRegisteredApp): void;
  byId(id: string): FakeRegisteredApp | undefined;
  byClientId(clientId: string): FakeRegisteredApp | undefined;
  all(): FakeRegisteredApp[];
  /** Removes the apps created through the manifest flow; the ones registered at start stay. */
  resetCreated(): void;
};

export function createAppRegistry(): AppRegistry {
  const apps = new Map<string, FakeRegisteredApp>();
  return {
    add: (app) => void apps.set(app.id, app),
    byId: (id) => apps.get(id),
    byClientId: (clientId) =>
      [...apps.values()].find((app) => app.clientId === clientId),
    all: () => [...apps.values()],
    resetCreated() {
      for (const [id, app] of apps)
        if (app.createdFromManifest) apps.delete(id);
    },
  };
}
