// SPDX-License-Identifier: LicenseRef-Proprietary

// Better Auth names itself after the product it is made for (#740): `appName` is the name of the identity the application hands
// in, so a deployment of another product does not present itself as code-review.com (the name shows in the authenticator
// apps of two-factor setups and in the links Better Auth builds). The instance is only built here, nothing reaches a database.
//
// @vitest-environment node
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/schema.ts";
import { identityFor } from "../product-identity/identities.ts";
import { loadAuthConfig } from "./config.ts";
import { createAuth } from "./auth.ts";

const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

const config = loadAuthConfig({
  APP_SECRET: "a-secret-that-is-long-enough-for-the-test-0123456789",
  BETTER_AUTH_URL: "https://reviews.example.test",
});

describe("the name Better Auth presents", () => {
  // #740-T04
  it.each(["code-review-com", "factory"] as const)(
    "is the name of the product %s",
    (id) => {
      const product = identityFor(id);

      expect(createAuth({ db, config, product }).options.appName).toBe(
        product.name,
      );
    },
  );
});
