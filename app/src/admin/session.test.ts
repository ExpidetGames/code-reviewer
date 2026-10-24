// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the second guard of the portal's pages (the proxy is the first): `requireAdmin()` returns the
// instance admin, sends nobody to the sign-in without a session, and gives a signed in person who is not
// an admin the 404 page; and every page of the portal asks it before it reads anything.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import type { SessionLookup } from "../auth/session-user.ts";
import { discoverRoutes, concretePath } from "../test-support/routes.ts";
import { isInternalPortalPath } from "./paths.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
  getAdminService: vi.fn(),
}));
vi.mock("../auth/session.ts", () => ({ currentLookup: session.currentLookup }));
vi.mock("@/auth/session", () => ({ currentLookup: session.currentLookup }));
vi.mock("./shared.ts", () => ({ getAdminService: session.getAdminService }));
vi.mock("@/admin/shared", () => ({ getAdminService: session.getAdminService }));

import { requireAdmin } from "./session.ts";

const ADMIN = { id: "a", isInstanceAdmin: true } as unknown as SessionUser;
const MEMBER = { id: "m", isInstanceAdmin: false } as unknown as SessionUser;

function digestOf(error: unknown): string | undefined {
  return (error as { digest?: string } | null)?.digest;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("requireAdmin", () => {
  it("returns the instance admin", async () => {
    session.currentLookup.mockResolvedValue({ kind: "user", user: ADMIN });

    await expect(requireAdmin()).resolves.toBe(ADMIN);
  });

  // #99-SR-24
  it("returns the instance admin whose address is not verified yet, to repair the mail server", async () => {
    session.currentLookup.mockResolvedValue({
      kind: "unverified",
      user: ADMIN,
    });

    await expect(requireAdmin()).resolves.toBe(ADMIN);
  });

  // #99-SR-24
  it.each(["unverified", "no_workspace"] as const)(
    "gives a person who is not an admin and is %s the 404 page too",
    async (kind) => {
      session.currentLookup.mockResolvedValue({ kind, user: MEMBER });

      const error = await requireAdmin().then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(digestOf(error)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    },
  );

  it("gives a signed in person who is not an admin the 404 page", async () => {
    session.currentLookup.mockResolvedValue({ kind: "user", user: MEMBER });

    const error = await requireAdmin().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(digestOf(error)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("lets the sign-in redirect of a person without a session through", async () => {
    session.currentLookup.mockResolvedValue({ kind: "none" });

    const error = await requireAdmin().then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(digestOf(error)).toMatch(/^NEXT_REDIRECT;/);
  });
});

describe("every page of the portal", () => {
  const pages = discoverRoutes().filter(
    ({ route, file }) =>
      isInternalPortalPath(concretePath(route)) && /page\.tsx$/.test(file),
  );

  it("is found on the file system", () => {
    expect(pages.length).toBeGreaterThanOrEqual(5);
  });

  // The 404 comes before any data is read: the page of a person who is not an admin never reaches the service.
  it.each(pages.map(({ route, file }) => ({ route, file })))(
    "answers the 404 page to a person who is not an admin before it reads anything: $route",
    async ({ file }) => {
      session.currentLookup.mockResolvedValue({ kind: "user", user: MEMBER });
      const page = (await import(/* @vite-ignore */ file)) as {
        default: () => Promise<unknown>;
      };

      const error = await page.default().then(
        () => null,
        (thrown: unknown) => thrown,
      );

      expect(digestOf(error)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(session.getAdminService).not.toHaveBeenCalled();
    },
  );
});
