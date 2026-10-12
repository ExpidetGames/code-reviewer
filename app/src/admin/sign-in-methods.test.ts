// SPDX-License-Identifier: Apache-2.0

// Pins down the rules for the ways to sign in: what is on when nothing was ever saved, what is
// actually on when GitHub is switched on but not configured, and which changes are refused.
import { describe, expect, it } from "vitest";
import {
  checkSignInMethods,
  effectiveSignInMethods,
} from "./sign-in-methods.ts";

describe("which ways to sign in are on", () => {
  it("offers email with password, and GitHub where it is configured, when nothing was saved", () => {
    expect(effectiveSignInMethods(undefined, false)).toEqual({
      emailPassword: true,
      github: false,
    });
    expect(effectiveSignInMethods(undefined, true)).toEqual({
      emailPassword: true,
      github: true,
    });
  });

  // #102-GH-15
  it("does not offer GitHub that is switched on while it is not configured", () => {
    expect(
      effectiveSignInMethods({ emailPassword: true, github: true }, false),
    ).toEqual({ emailPassword: true, github: false });
  });

  it("follows what was saved when GitHub is configured", () => {
    expect(
      effectiveSignInMethods({ emailPassword: false, github: true }, true),
    ).toEqual({ emailPassword: false, github: true });
  });

  it("keeps email with password on when nothing else would be left, so nobody is locked out", () => {
    expect(
      effectiveSignInMethods({ emailPassword: false, github: true }, false),
    ).toEqual({ emailPassword: true, github: false });
    expect(
      effectiveSignInMethods({ emailPassword: false, github: false }, true),
    ).toEqual({ emailPassword: true, github: false });
  });
});

describe("a change of the ways to sign in", () => {
  const configured = { githubConfigured: true, actorHasGithubIdentity: true };

  it("is accepted when at least one way stays on", () => {
    expect(
      checkSignInMethods({ emailPassword: true, github: false }, configured),
    ).toEqual({ ok: true });
    expect(
      checkSignInMethods({ emailPassword: true, github: true }, configured),
    ).toEqual({ ok: true });
  });

  // #98-AD-09
  it("is refused when both ways are switched off", () => {
    expect(
      checkSignInMethods({ emailPassword: false, github: false }, configured),
    ).toEqual({ ok: false, error: "at_least_one_method" });
  });

  // #98-AD-09
  it("is refused when GitHub is switched on while it is not configured", () => {
    expect(
      checkSignInMethods(
        { emailPassword: true, github: true },
        { githubConfigured: false, actorHasGithubIdentity: true },
      ),
    ).toEqual({ ok: false, error: "github_not_configured" });
  });

  // #98-AD-16
  it("is refused as GitHub only when the acting admin has no linked GitHub identity", () => {
    expect(
      checkSignInMethods(
        { emailPassword: false, github: true },
        { githubConfigured: true, actorHasGithubIdentity: false },
      ),
    ).toEqual({ ok: false, error: "admin_needs_github_identity" });
  });

  // #98-AD-16
  it("is accepted as GitHub only when the acting admin has a linked GitHub identity", () => {
    expect(
      checkSignInMethods({ emailPassword: false, github: true }, configured),
    ).toEqual({ ok: true });
  });

  it("does not need a GitHub identity while email with password stays on", () => {
    expect(
      checkSignInMethods(
        { emailPassword: true, github: true },
        { githubConfigured: true, actorHasGithubIdentity: false },
      ),
    ).toEqual({ ok: true });
  });
});
