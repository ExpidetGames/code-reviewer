// SPDX-License-Identifier: LicenseRef-Proprietary

// The guards of the data routes on the running server, with the session lookup replaced (it needs the request
// scope of Next.js): a route that is not about one workspace (`withSignedIn`) lets a person without a workspace
// in, because creating a workspace and accepting an invitation are what they are there for, but never a person
// whose address is not verified, and never anybody without a session; a route about a workspace
// (`withWorkspace`) asks for the workspace before anything else. In every refusal the handler does not run.
import { describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../auth/session-user.ts";
import { sessionUser } from "../test-support/session-lookup.ts";

const session = vi.hoisted(() => ({
  currentLookup: vi.fn<() => Promise<SessionLookup>>(),
}));
vi.mock("../auth/session.ts", () => ({
  currentLookup: session.currentLookup,
}));
// The membership is read from the database only for a person who is let in; these tests are about the others.
vi.mock("../db/startup.ts", () => ({
  getDatabase: () => {
    throw new Error("The database must not be read for a refusal.");
  },
}));

const { withSignedIn, withWorkspace } = await import("./access-runtime.ts");

const PERSON = sessionUser("person");

function handlerThatAnswers() {
  return vi.fn(async () => Response.json({ ok: true }));
}

describe("a route that is not about one workspace", () => {
  // #101-WM-02
  it.each([
    ["a member of a workspace", { kind: "user", user: PERSON }],
    ["a person without a workspace", { kind: "no_workspace", user: PERSON }],
  ] as const)("runs for %s, with the person", async (_who, lookup) => {
    session.currentLookup.mockResolvedValue(lookup);
    const handler = handlerThatAnswers();

    const response = await withSignedIn(handler);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(PERSON);
  });

  // #99-SR-23
  it("refuses a person whose address is not verified with 403 email_not_verified, and does not run", async () => {
    session.currentLookup.mockResolvedValue({
      kind: "unverified",
      user: PERSON,
    });
    const handler = handlerThatAnswers();

    const response = await withSignedIn(handler);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "email_not_verified" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([["nobody is signed in", { kind: "none" }]] as const)(
    "refuses with 401 UNAUTHENTICATED when %s, and does not run",
    async (_why, lookup) => {
      session.currentLookup.mockResolvedValue(lookup);
      const handler = handlerThatAnswers();

      const response = await withSignedIn(handler);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
      expect(handler).not.toHaveBeenCalled();
    },
  );
});

describe("a route about a workspace", () => {
  it.each([
    [
      "is not verified",
      { kind: "unverified", user: PERSON },
      403,
      "email_not_verified",
    ],
    [
      "has no workspace",
      { kind: "no_workspace", user: PERSON },
      403,
      "no_workspace_access",
    ],
    ["is not signed in", { kind: "none" }, 401, "UNAUTHENTICATED"],
  ] as const)(
    "refuses a person who %s before it looks at the workspace, and does not run",
    async (_why, lookup, status, error) => {
      session.currentLookup.mockResolvedValue(lookup);
      const handler = handlerThatAnswers();

      const response = await withWorkspace("acme", "view", handler);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(handler).not.toHaveBeenCalled();
    },
  );
});
