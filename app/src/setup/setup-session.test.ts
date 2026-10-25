// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the setup session cookie: valid for 30 minutes, bound to the issuance of the code it was
// made for, worthless when forged or tampered with, and set with the attributes that keep it from
// scripts and other sites.
import { describe, expect, it } from "vitest";
import {
  checkSetupSession,
  clearedSetupSessionCookie,
  createSetupSessionToken,
  readSetupSessionCookie,
  SETUP_SESSION_TTL_MS,
  setupSessionCookie,
} from "./setup-session.ts";

const SECRET = "test-app-secret-0123456789-0123456789-abc";
const NOW = 5_000_000;

describe("the setup session", () => {
  it("is valid right after the code was accepted", () => {
    const token = createSetupSessionToken(SECRET, "issue-1", NOW);

    expect(checkSetupSession(SECRET, token, "issue-1", NOW + 1000)).toEqual({
      ok: true,
    });
  });

  // #97-SU-09
  it("is expired after 30 minutes", () => {
    const token = createSetupSessionToken(SECRET, "issue-1", NOW);

    expect(
      checkSetupSession(
        SECRET,
        token,
        "issue-1",
        NOW + SETUP_SESSION_TTL_MS - 1,
      ),
    ).toEqual({ ok: true });
    expect(
      checkSetupSession(SECRET, token, "issue-1", NOW + SETUP_SESSION_TTL_MS),
    ).toEqual({ ok: false, reason: "expired" });
  });

  // #97-SU-02
  it("is worthless after a restart, because the new process has another issuance id", () => {
    const token = createSetupSessionToken(SECRET, "issue-1", NOW);

    expect(checkSetupSession(SECRET, token, "issue-2", NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(checkSetupSession(SECRET, token, null, NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("is worthless when it was signed with another secret, or changed", () => {
    const token = createSetupSessionToken(`${SECRET}x`, "issue-1", NOW);
    const own = createSetupSessionToken(SECRET, "issue-1", NOW);
    const [payload = "", signature = ""] = own.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, issue: "issue-1", exp: NOW * 100, jti: "x" }),
    ).toString("base64url");

    expect(checkSetupSession(SECRET, token, "issue-1", NOW).ok).toBe(false);
    expect(
      checkSetupSession(
        SECRET,
        `${forgedPayload}.${signature}`,
        "issue-1",
        NOW,
      ),
    ).toEqual({ ok: false, reason: "missing" });
    expect(payload).not.toBe("");
  });

  it("is missing without a cookie, and a signed value of another purpose is not a session", () => {
    expect(checkSetupSession(SECRET, undefined, "issue-1", NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(checkSetupSession(SECRET, "garbage", "issue-1", NOW)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  // #97-SU-05
  it("is set HttpOnly and SameSite, and Secure only over https", () => {
    const token = createSetupSessionToken(SECRET, "issue-1", NOW);

    const plain = setupSessionCookie(token, false);
    const secure = setupSessionCookie(token, true);

    for (const cookie of [plain, secure]) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=1800");
    }
    expect(plain).not.toContain("Secure");
    expect(secure).toContain("Secure");
    expect(clearedSetupSessionCookie(true)).toContain("Max-Age=0");
  });

  it("is read from a Cookie header among other cookies", () => {
    expect(readSetupSessionCookie("a=1; cr_setup_session=abc.def; b=2")).toBe(
      "abc.def",
    );
    expect(readSetupSessionCookie("a=1")).toBeUndefined();
    expect(readSetupSessionCookie(null)).toBeUndefined();
    expect(readSetupSessionCookie("cr_setup_session=")).toBeUndefined();
  });
});
