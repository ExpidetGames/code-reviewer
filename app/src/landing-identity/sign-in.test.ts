// SPDX-License-Identifier: LicenseRef-Proprietary

// The cookie is cleared at the first sign in that sees it, whatever came of storing the identity.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/schema.ts";
import {
  LANDING_IDENTITY_COOKIE,
  LANDING_IDENTITY_HOST_COOKIE,
} from "./identity.ts";
import { captureLandingIdentityAtSignIn } from "./sign-in.ts";

/** A database that fails on every use, as a store that is down. */
const brokenDb = new Proxy(
  {},
  {
    get() {
      throw new Error("database is down");
    },
  },
) as Kysely<Database>;

function contextWith(cookie: string) {
  const cleared: { name: string; options: unknown }[] = [];
  return {
    cleared,
    context: {
      headers: new Headers({ cookie }),
      setCookie: (name: string, _value: string, options?: unknown) => {
        cleared.push({ name, options });
      },
    },
  };
}

describe("the landing cookie at a sign in", () => {
  // #692-T03
  it("is cleared even when storing the identity fails, and the failure is logged by its name only", async () => {
    const { cleared, context } = contextWith(
      `${LANDING_IDENTITY_COOKIE}=did-1~sid-1`,
    );
    const logged: string[] = [];

    await captureLandingIdentityAtSignIn(brokenDb, "u1", context, (message) =>
      logged.push(message),
    );

    expect(cleared).toEqual([
      {
        name: "cr-landing",
        options: expect.objectContaining({ path: "/", maxAge: 0 }),
      },
    ]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("LANDING_IDENTITY_FAILED");
    expect(logged[0]).not.toContain("did-1");
  });

  // #692-T03
  it("is cleared when the value is not valid either, without touching the database", async () => {
    const { cleared, context } = contextWith(`${LANDING_IDENTITY_COOKIE}=bad`);

    await captureLandingIdentityAtSignIn(brokenDb, "u1", context, () => {});

    expect(cleared.map((c) => c.name)).toEqual(["cr-landing"]);
  });

  // #692-T03
  it("clears the __Host- cookie with Secure, as the browser demands", async () => {
    const { cleared, context } = contextWith(
      `${LANDING_IDENTITY_HOST_COOKIE}=did-1~sid-1`,
    );

    await captureLandingIdentityAtSignIn(brokenDb, "u1", context, () => {});

    expect(cleared).toEqual([
      {
        name: "__Host-cr-landing",
        options: expect.objectContaining({
          path: "/",
          maxAge: 0,
          secure: true,
        }),
      },
    ]);
  });

  // #692-T03
  it("never throws, not even when clearing fails", async () => {
    const logged: string[] = [];

    await expect(
      captureLandingIdentityAtSignIn(
        brokenDb,
        "u1",
        {
          headers: new Headers({ cookie: `${LANDING_IDENTITY_COOKIE}=a~b` }),
          setCookie: () => {
            throw new Error("no response");
          },
        },
        (message) => logged.push(message),
      ),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(2);
  });

  // #692-T06
  it("does nothing for a request without the cookie", async () => {
    const { cleared, context } = contextWith("a=b");

    await captureLandingIdentityAtSignIn(brokenDb, "u1", context, () => {});

    expect(cleared).toEqual([]);
  });
});
