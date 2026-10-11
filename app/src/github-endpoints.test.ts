// SPDX-License-Identifier: Apache-2.0

// Pins down the one rule for the GitHub addresses that the sign in and the GitHub App share.
import { describe, expect, it } from "vitest";
import {
  resolveGithubEndpoint,
  testGithubEndpointsAllowed,
} from "./github-endpoints.ts";

const REAL = "https://api.github.com";
const FAKE = "http://127.0.0.1:4010";

describe("the flag that allows test endpoints", () => {
  // CR-43-T03
  it("is on only for the exact value true, ignoring surrounding whitespace", () => {
    const flag = (value: string | undefined) =>
      testGithubEndpointsAllowed({ ALLOW_TEST_GITHUB_ENDPOINTS: value });

    expect(flag("true")).toBe(true);
    expect(flag(" true\n")).toBe(true);
    for (const off of [undefined, "", "false", "TRUE", "True", "1", "yes"])
      expect(flag(off), String(off)).toBe(false);
  });
});

describe("resolving a GitHub address", () => {
  // CR-43-T03
  it("uses the real GitHub when nothing is set", () => {
    for (const unset of [undefined, "", "   "])
      expect(resolveGithubEndpoint(unset, REAL, false)).toEqual({
        ok: true,
        url: REAL,
      });
  });

  // CR-43-T03
  it("refuses any other address without the flag, however it is spelled", () => {
    for (const raw of [FAKE, " http://127.0.0.1:4010/ ", "https://evil.test"])
      expect(resolveGithubEndpoint(raw, REAL, false), raw).toEqual({
        ok: false,
        problem: "not_allowed",
      });
  });

  // CR-43-T03
  it("accepts another address with the flag, without a trailing slash", () => {
    expect(resolveGithubEndpoint(`${FAKE}//`, REAL, true)).toEqual({
      ok: true,
      url: FAKE,
    });
    expect(
      resolveGithubEndpoint(" http://127.0.0.1:4010/x/ ", REAL, true),
    ).toEqual({
      ok: true,
      url: `${FAKE}/x`,
    });
  });

  it("accepts the real GitHub named explicitly, with or without a trailing slash, even without the flag", () => {
    for (const raw of [REAL, `${REAL}/`, ` ${REAL} `])
      expect(resolveGithubEndpoint(raw, REAL, false), raw).toEqual({
        ok: true,
        url: REAL,
      });
  });

  it("refuses what is not an http or https URL, with or without the flag", () => {
    for (const raw of ["api.github.com", "ftp://127.0.0.1", "javascript:1"])
      for (const allowed of [false, true])
        expect(resolveGithubEndpoint(raw, REAL, allowed), raw).toEqual({
          ok: false,
          problem: "invalid",
        });
  });
});
