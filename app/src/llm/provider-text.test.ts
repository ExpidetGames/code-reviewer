// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { boundProviderText, MAX_PROVIDER_TEXT_CHARS } from "./provider-text.ts";

describe("the provider string a tenant wrote, made safe to log and show", () => {
  // #432-T18
  it("keeps a plain provider id as it is", () => {
    expect(boundProviderText("openrouter")).toBe("openrouter");
  });

  // #432-T18
  it("cuts a long string to the bound and marks the cut", () => {
    const text = boundProviderText("a".repeat(10_000));
    expect(text.length).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_CHARS);
    expect(text.endsWith("...")).toBe(true);
  });

  // #432-T18
  it("replaces line breaks, escape characters and anything outside a printable set", () => {
    const text = boundProviderText(`evil\nname\r\u001b[31mred\u0000‮ é`);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).not.toMatch(/[\n\r\u001b\u0000]/);
    expect(text.length).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_CHARS);
  });

  // #432-T18
  it("is bounded for any input, including one long run of control characters", () => {
    const text = boundProviderText("\n".repeat(10_000));
    expect(text.length).toBeLessThanOrEqual(MAX_PROVIDER_TEXT_CHARS);
    expect(text).not.toContain("\n");
  });
});
