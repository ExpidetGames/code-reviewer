// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  clientTokenEnvironmentOf,
  keyEnvironmentOf,
  parseSettingsInput,
} from "./settings.ts";

describe("which environment a Paddle API key belongs to", () => {
  // #437-T03
  it.each([
    ["pdl_sdbx_apikey_0123456789", "sandbox"],
    ["pdl_live_apikey_0123456789", "live"],
    // `_sdbx` somewhere inside is no sandbox key: only the prefix counts.
    ["abc_sdbx", null],
    ["live_pdl_sdbx_x", null],
    ["pdl_sdbx", null],
    ["sk-not-a-paddle-key", null],
  ])("%s is %s", (key, environment) => {
    expect(keyEnvironmentOf(key)).toBe(environment);
  });
});

describe("which environment a client-side token belongs to", () => {
  // #437-T03
  it.each([
    ["test_0123456789abcdef0123456789a", "sandbox"],
    ["live_0123456789abcdef0123456789a", "live"],
    ["token_0123456789abcdef", null],
    ["test", null],
  ])("%s is %s", (token, environment) => {
    expect(clientTokenEnvironmentOf(token)).toBe(environment);
  });

  // #437-T03
  it("refuses a token of the other environment, and one of none, when the settings are parsed", () => {
    const input = (clientToken: string, environment: string) => ({
      environment,
      clientToken,
      graceDays: 7,
    });

    expect(
      parseSettingsInput(input("test_0123456789abcdef0123456789a", "live")),
    ).toEqual({
      ok: false,
      issues: [
        { field: "clientToken", code: "client_token_environment_mismatch" },
      ],
    });
    expect(
      parseSettingsInput(input("live_0123456789abcdef0123456789a", "sandbox")),
    ).toEqual({
      ok: false,
      issues: [
        { field: "clientToken", code: "client_token_environment_mismatch" },
      ],
    });
    expect(
      parseSettingsInput(input("abcdef0123456789", "sandbox")),
    ).toEqual({
      ok: false,
      issues: [{ field: "clientToken", code: "client_token_invalid" }],
    });
    // Empty stays allowed: the page can be saved before the token is at hand.
    expect(parseSettingsInput(input("", "live")).ok).toBe(true);
    expect(
      parseSettingsInput(input("live_0123456789abcdef0123456789a", "live")).ok,
    ).toBe(true);
  });
});
