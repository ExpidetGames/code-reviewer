// Pins down that a sign in which goes wrong ends on the login page with an error code and leaves
// nothing behind: no user, no session. Covers a forged or missing state, a callback address that
// points to another site, a person who refuses at GitHub, and GitHub failing during the exchange.
import { describe, expect, it } from "vitest";
import { createAuthHarness } from "../test-support/auth-harness.ts";

async function expectNothingCreated(
  harness: Awaited<ReturnType<typeof createAuthHarness>>,
) {
  expect(await harness.db.selectFrom("users").selectAll().execute()).toEqual(
    [],
  );
  expect(await harness.db.selectFrom("accounts").selectAll().execute()).toEqual(
    [],
  );
  expect(await harness.db.selectFrom("sessions").selectAll().execute()).toEqual(
    [],
  );
}

function errorOf(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  const url = new URL(location, "http://localhost:3000");
  expect(url.pathname).toBe("/login");
  return url.searchParams.get("error");
}

describe("a callback whose state does not belong to the sign in", () => {
  // CR-18-T08
  it("is rejected when the state was changed", async () => {
    const harness = await createAuthHarness();
    const { authorizeUrl, cookies } = await harness.startSignIn();
    const callbackUrl = await harness.github.authorize(
      authorizeUrl!,
      "octocat",
    );
    callbackUrl.searchParams.set("state", "forged-state-value");

    const response = await harness.callback(callbackUrl, cookies);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("state_mismatch");
    await expectNothingCreated(harness);
  });

  // CR-18-T08
  it("is rejected when the state is missing", async () => {
    const harness = await createAuthHarness();
    const { authorizeUrl, cookies } = await harness.startSignIn();
    const callbackUrl = await harness.github.authorize(
      authorizeUrl!,
      "octocat",
    );
    callbackUrl.searchParams.delete("state");

    const response = await harness.callback(callbackUrl, cookies);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("state_not_found");
    await expectNothingCreated(harness);
  });

  // CR-18-T08
  it("is rejected when it arrives without the cookies of the browser that started the sign in", async () => {
    const harness = await createAuthHarness();
    const { authorizeUrl } = await harness.startSignIn();
    const callbackUrl = await harness.github.authorize(
      authorizeUrl!,
      "octocat",
    );

    const response = await harness.callback(callbackUrl, new Map());

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("state_mismatch");
    await expectNothingCreated(harness);
  });
});

describe("a sign in that asks to continue on another site", () => {
  // CR-18-T09
  it.each([
    "https://evil.example",
    "//evil.example",
    "https://evil.example/login",
  ])(
    "is refused at the start when the callback address is %s",
    async (callbackURL) => {
      const harness = await createAuthHarness();

      const { response, authorizeUrl } = await harness.startSignIn({
        callbackURL,
      });

      expect(response.status).toBe(403);
      expect(authorizeUrl).toBeUndefined();
      expect(response.headers.get("location")).toBeNull();
      await expectNothingCreated(harness);
    },
  );

  // CR-18-T09
  it("refuses another site as the address for failures or for new users", async () => {
    const harness = await createAuthHarness();

    const failure = await harness.startSignIn({
      callbackURL: "/",
      errorCallbackURL: "https://evil.example",
    });
    const newUser = await harness.startSignIn({
      callbackURL: "/",
      newUserCallbackURL: "https://evil.example",
    });

    expect(failure.response.status).toBe(403);
    expect(newUser.response.status).toBe(403);
  });

  // CR-18-T09
  it("continues on the app's own address after the sign in", async () => {
    const harness = await createAuthHarness();
    const { authorizeUrl, cookies } = await harness.startSignIn({
      callbackURL: "/projects",
    });
    const callbackUrl = await harness.github.authorize(
      authorizeUrl!,
      "octocat",
    );

    const response = await harness.callback(callbackUrl, cookies);

    expect(response.headers.get("location")).toBe("/projects");
  });
});

describe("a person who refuses the access at GitHub", () => {
  // CR-18-T10
  it("lands on the login page with access_denied and without a user or a session", async () => {
    const harness = await createAuthHarness();
    const { authorizeUrl, cookies } = await harness.startSignIn();
    const callbackUrl = await harness.github.deny(authorizeUrl!);
    expect(callbackUrl.searchParams.get("error")).toBe("access_denied");

    const response = await harness.callback(callbackUrl, cookies);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("access_denied");
    await expectNothingCreated(harness);
  });
});

describe("GitHub failing while the sign in is completed", () => {
  // CR-18-T11
  it("lands on the login page when the token endpoint answers with an error, and a new attempt works", async () => {
    const harness = await createAuthHarness();
    harness.github.failTokenEndpoint({ kind: "status", status: 500 });
    const first = await harness.startSignIn();
    const callbackUrl = await harness.github.authorize(
      first.authorizeUrl!,
      "octocat",
    );

    const response = await harness.callback(callbackUrl, first.cookies);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("invalid_code");
    await expectNothingCreated(harness);

    harness.github.failTokenEndpoint(null);
    const retry = await harness.signIn("octocat");
    expect(retry.response.headers.get("location")).toBe("/");
    expect(
      await harness.db.selectFrom("users").selectAll().execute(),
    ).toHaveLength(1);
  });

  // CR-18-T11
  it("lands on the login page when the token endpoint does not answer in time", async () => {
    const harness = await createAuthHarness({ githubRequestTimeoutMs: 200 });
    harness.github.failTokenEndpoint({ kind: "delay", delayMs: 5000 });
    const { authorizeUrl, cookies } = await harness.startSignIn();
    const callbackUrl = await harness.github.authorize(
      authorizeUrl!,
      "octocat",
    );

    const response = await harness.callback(callbackUrl, cookies);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("invalid_code");
    await expectNothingCreated(harness);
  });
});
