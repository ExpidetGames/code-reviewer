// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createLlmKeyApi } from "./api.ts";

function recorder() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    });
    return Response.json({ ok: true });
  });
  return { calls, fetchImpl };
}

describe("the calls of the key pages", () => {
  // #426-T07
  it("name the provider in the address and keep it out of the body", async () => {
    const { calls, fetchImpl } = recorder();
    const api = createLlmKeyApi(fetchImpl, "acme");

    await api.save({ provider: "fakeai", apiKey: "k-1" });
    await api.test({ provider: "fakeai", apiKey: "k-2" });
    await api.remove("fakeai");

    expect(calls).toEqual([
      {
        url: "/api/w/acme/llm-keys/fakeai",
        method: "PUT",
        body: { apiKey: "k-1" },
      },
      {
        url: "/api/w/acme/llm-keys/fakeai/test",
        method: "POST",
        body: { apiKey: "k-2" },
      },
      {
        url: "/api/w/acme/llm-keys/fakeai",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });
});
