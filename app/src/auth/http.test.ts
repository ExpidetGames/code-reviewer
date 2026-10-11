// Pins down which calls of Better Auth's HTTP interface are passed on: only the sign in with email
// and password and the three of the GitHub sign in. Everything else, including endpoints that exist
// in Better Auth (the sign-up among them), is answered with 404 without reaching it.
import { describe, expect, it, vi } from "vitest";
import { handleAuthRequest, isAuthEndpointAllowed } from "./http.ts";

describe("which Better Auth calls are reachable over HTTP", () => {
  it.each([
    ["POST", "/api/auth/sign-in/social"],
    ["GET", "/api/auth/callback/github"],
    ["POST", "/api/auth/sign-out"],
    ["POST", "/api/auth/sign-in/email"],
  ])("passes on %s %s", (method, pathname) => {
    expect(isAuthEndpointAllowed(method, pathname)).toBe(true);
  });

  it.each([
    ["POST", "/api/auth/update-user"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/revoke-sessions"],
    ["POST", "/api/auth/link-social"],
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-in/email/"],
    ["POST", "/api/auth/request-password-reset"],
    ["POST", "/api/auth/reset-password"],
    ["POST", "/api/auth/change-password"],
    ["GET", "/api/auth/callback/google"],
    ["POST", "/api/auth/callback/github"],
    ["GET", "/api/auth/sign-in/social"],
    ["GET", "/api/auth/sign-out"],
    ["POST", "/api/auth/sign-out/"],
    ["POST", "/api/auth//sign-out"],
    ["POST", "/api/auth/sign-in/social/extra"],
    ["POST", "/api/auth"],
    ["POST", "/api/other/sign-out"],
  ])("answers %s %s with 404", async (method, pathname) => {
    const handler = vi.fn();

    const response = await handleAuthRequest(
      { handler },
      new Request(`http://localhost:3000${pathname}`, { method }),
    );

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });
});
