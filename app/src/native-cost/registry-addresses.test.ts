// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  nativeCostRegistryFor,
  registryAddressesOf,
  sameAddress,
} from "./registry-addresses.ts";
import { NATIVE_PROVIDERS_VARIABLE } from "./switch.ts";

describe("the addresses of the app's providers", () => {
  // #578-T28
  it("are the API addresses of the registry, by the provider id of the catalog", () => {
    expect(
      registryAddressesOf([
        { id: "openrouter", apiBaseUrl: "https://openrouter.ai/api/v1" },
        { id: "anthropic", apiBaseUrl: "https://api.anthropic.com/v1" },
        { id: "some_provider", apiBaseUrl: "https://api.example.com/v1" },
      ]),
    ).toEqual({
      openrouter: "https://openrouter.ai/api/v1",
      anthropic: "https://api.anthropic.com/v1",
      "some-provider": "https://api.example.com/v1",
    });
  });

  // #578-T28
  it("compare equal up to one trailing slash and nothing else", () => {
    const address = "https://api.anthropic.com/v1";
    expect(sameAddress(address, address)).toBe(true);
    expect(sameAddress(`${address}/`, address)).toBe(true);
    expect(sameAddress(address, `${address}/`)).toBe(true);
    for (const other of [
      "https://api.anthropic.com",
      "https://api.anthropic.com/v1//",
      "https://API.anthropic.com/v1",
      "https://api.anthropic.com/v1/messages",
      "https://attacker.example/v1",
      "http://api.anthropic.com/v1",
    ])
      expect(sameAddress(other, address)).toBe(false);
  });
});

describe("what the running server tells the native cost service about its registry", () => {
  // #578-T31
  it("keeps both providers legacy while the switch is off, and the addresses the same", () => {
    const off = nativeCostRegistryFor({});

    expect(off.legacyProviders).toEqual(["openrouter", "anthropic"]);
    expect(off.registryAddresses).toEqual({
      openrouter: "https://openrouter.ai/api/v1",
      anthropic: "https://api.anthropic.com/v1",
    });
  });

  // #578-T31
  it("releases both providers when the switch is on, and still pins the addresses", () => {
    const on = nativeCostRegistryFor({ [NATIVE_PROVIDERS_VARIABLE]: "1" });

    expect(on.legacyProviders).toEqual([]);
    expect(Object.keys(on.registryAddresses).sort()).toEqual([
      "anthropic",
      "openrouter",
    ]);
  });
});
