// Starts the fake GitHub as its own process, for the Playwright journeys and later the Docker test
// stack. Configuration comes from the environment; the values are dummies shared with the app under
// test. Test code adds accounts through POST /__fake/users and clears state with POST /__fake/reset.
//
//   GITHUB_FAKE_CLIENT_ID      required
//   GITHUB_FAKE_CLIENT_SECRET  required
//   GITHUB_FAKE_APP_ID         optional, together with the next one: switches the GitHub App API on
//   GITHUB_FAKE_APP_PUBLIC_KEY SPKI PEM the App JWTs are checked with; installations are added
//                              with POST /__fake/installations
//   GITHUB_FAKE_APP_SLUG       optional: the slug the app's comments are authored with (<slug>[bot])
//   GITHUB_FAKE_SELF_LINKS     optional, "true": links in answers (html_url) point to the fake itself
//   GITHUB_FAKE_PORT           default 4010
//   GITHUB_FAKE_HOST           default 127.0.0.1
import { startGithubFake } from "./server.ts";

const clientId = process.env.GITHUB_FAKE_CLIENT_ID;
const clientSecret = process.env.GITHUB_FAKE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    "GITHUB_FAKE_CLIENT_ID and GITHUB_FAKE_CLIENT_SECRET must be set.",
  );
  process.exit(1);
}

const appId = process.env.GITHUB_FAKE_APP_ID;
const publicKeyPem = process.env.GITHUB_FAKE_APP_PUBLIC_KEY;
if ((appId === undefined) !== (publicKeyPem === undefined)) {
  console.error(
    "GITHUB_FAKE_APP_ID and GITHUB_FAKE_APP_PUBLIC_KEY must be set together.",
  );
  process.exit(1);
}

const fake = await startGithubFake({
  clientId,
  clientSecret,
  ...(appId === undefined || publicKeyPem === undefined
    ? {}
    : { appId, publicKeyPem }),
  ...(process.env.GITHUB_FAKE_APP_SLUG
    ? { appSlug: process.env.GITHUB_FAKE_APP_SLUG }
    : {}),
  selfLinks: process.env.GITHUB_FAKE_SELF_LINKS === "true",
  host: process.env.GITHUB_FAKE_HOST || "127.0.0.1",
  port: Number(process.env.GITHUB_FAKE_PORT) || 4010,
});
console.info(`fake github listening on ${fake.baseUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void fake.close().finally(() => process.exit(0));
  });
}
