// SPDX-License-Identifier: LicenseRef-Proprietary

// Not a journey: the first step of the web server command of every app under test (playwright.config.ts,
// playwright.hosted.config.ts, playwright.dynamic.config.ts), run before `pnpm migrate`. Drops and makes the app's
// database on the Postgres server the run was given, so every run starts from an empty schema the way a new
// deployment does (migrations are a step of their own in a serverless deployment, `pnpm migrate`). Node runs it as it
// is (type stripping): relative imports with the extension and no TypeScript-only runtime syntax. It reads its two
// values from the environment because the configuration, which knows them, is not loadable here.
import pg from "pg";

const adminUrl = process.env.E2E_ADMIN_DATABASE_URL;
const name = process.env.E2E_DATABASE_NAME;
if (!adminUrl || !name || !/^[a-z0-9_]{1,63}$/.test(name))
  throw new Error(
    "E2E_ADMIN_DATABASE_URL and E2E_DATABASE_NAME are required (the configurations set them).",
  );

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  // The name is checked above to be plain; identifiers cannot be parameters.
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${name}`);
} finally {
  await client.end();
}
