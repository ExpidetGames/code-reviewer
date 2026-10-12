// SPDX-License-Identifier: Apache-2.0

// Pins down that the ways to sign in the admin switched off are really off at the HTTP interface: a
// refused way never reaches Better Auth and is not counted by the sign-in limit, sign out always works,
// and a way that is on is passed on as before. If the setting cannot be read, nothing is let through.
import { describe, expect, it, vi } from "vitest";
import type { SignInMethods } from "../admin/sign-in-methods.ts";
import { handleAuthRequest } from "./http.ts";
import type { SignInLimiter } from "./sign-in-limit.ts";

function setup(methods: () => Promise<SignInMethods>) {
  const handler = vi.fn((request: Request) =>
    Promise.resolve(Response.json({ passedOn: true, url: request.url })),
  );
  const limiter: SignInLimiter = {
    check: vi.fn(() => Promise.resolve({ allowed: true as const })),
    succeeded: vi.fn(() => Promise.resolve()),
  };
  const call = (
    method: string,
    path: string,
    body?: unknown,
    origin = "http://localhost:3000",
  ) =>
    handleAuthRequest(
      { handler },
      new Request(`${origin}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      limiter,
      methods,
    );
  return { handler, limiter, call };
}

const EMAIL_ONLY = () =>
  Promise.resolve({ emailPassword: true, github: false });
const GITHUB_ONLY = () =>
  Promise.resolve({ emailPassword: false, github: true });
const BOTH = () => Promise.resolve({ emailPassword: true, github: true });

describe("a way to sign in that is switched off", () => {
  // #98-SIGN-IN-METHODS
  it("refuses the email and password sign in without counting it or reaching Better Auth", async () => {
    const { call, handler, limiter } = setup(GITHUB_ONLY);

    const response = await call("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "whatever-it-is",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "sign_in_method_disabled" });
    expect(limiter.check).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  // #98-SIGN-IN-METHODS, #102-GH-15
  it("refuses the start of the GitHub sign in", async () => {
    const { call, handler } = setup(EMAIL_ONLY);

    const response = await call("POST", "/api/auth/sign-in/social", {
      provider: "github",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "sign_in_method_disabled" });
    expect(handler).not.toHaveBeenCalled();
  });

  // #98-SIGN-IN-METHODS
  it("sends a person who comes back from GitHub to the login page with the reason", async () => {
    const { call, handler } = setup(EMAIL_ONLY);

    const response = await call(
      "GET",
      "/api/auth/callback/github?code=abc&state=s",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/login?error=sign_in_method_disabled",
    );
    expect(handler).not.toHaveBeenCalled();
  });

  // #98-SIGN-IN-METHODS
  it("sends the person back to the login page of the address they used, not of the server's own", async () => {
    const { call } = setup(EMAIL_ONLY);

    const response = await call(
      "GET",
      "/api/auth/callback/github?code=abc&state=s",
      undefined,
      "http://0.0.0.0:3000",
    );

    expect(response.headers.get("location")).toBe(
      "/login?error=sign_in_method_disabled",
    );
    expect(response.headers.get("location")).not.toContain("0.0.0.0");
  });

  it("still lets a person sign out", async () => {
    const { call, handler } = setup(() =>
      Promise.resolve({ emailPassword: false, github: false }),
    );

    const response = await call("POST", "/api/auth/sign-out");

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("a way to sign in that is on", () => {
  it("passes the email and password sign in on, counted as before", async () => {
    const { call, handler, limiter } = setup(BOTH);

    const response = await call("POST", "/api/auth/sign-in/email", {
      email: "admin@example.com",
      password: "whatever-it-is",
    });

    expect(response.status).toBe(200);
    expect(limiter.check).toHaveBeenCalledWith("admin@example.com");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("passes the GitHub sign in on", async () => {
    const { call, handler } = setup(GITHUB_ONLY);

    await call("POST", "/api/auth/sign-in/social", { provider: "github" });
    await call("GET", "/api/auth/callback/github?code=abc&state=s");

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("the GitHub sign in while the GitHub App has no user authorization", () => {
  async function callWithoutGithub(
    method: string,
    path: string,
    body?: unknown,
  ) {
    const handler = vi.fn(() => Promise.resolve(Response.json({})));
    const response = await handleAuthRequest(
      { handler },
      new Request(`http://localhost:3000${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      {
        check: () => Promise.resolve({ allowed: true as const }),
        succeeded: () => Promise.resolve(),
      },
      BOTH,
      () => Promise.resolve(null),
    );
    return { response, handler };
  }

  // #102-GH-15
  it("refuses the start with a stable code and reaches no handler", async () => {
    const { response, handler } = await callWithoutGithub(
      "POST",
      "/api/auth/sign-in/social",
      { provider: "github" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "github_not_configured" });
    expect(handler).not.toHaveBeenCalled();
  });

  // #102-GH-15
  it("sends a person who comes back from GitHub to the login page with the reason", async () => {
    const { response, handler } = await callWithoutGithub(
      "GET",
      "/api/auth/callback/github?code=abc&state=s",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/login?error=github_not_configured",
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a setting that cannot be read", () => {
  it("lets no sign in through", async () => {
    const { call, handler } = setup(() => Promise.reject(new Error("locked")));

    const email = await call("POST", "/api/auth/sign-in/email", {
      email: "a@example.com",
      password: "x",
    });
    const github = await call("POST", "/api/auth/sign-in/social", {});

    expect([email.status, github.status]).toEqual([503, 503]);
    expect(await email.json()).toEqual({ error: "sign_in_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not stop signing out", async () => {
    const { call, handler } = setup(() => Promise.reject(new Error("locked")));

    const response = await call("POST", "/api/auth/sign-out");

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
