// SPDX-License-Identifier: Apache-2.0

// Pins down the calls the project list makes: which route, which method and which body, for
// activating, deactivating and running the sync. The routes themselves are proven where they live.
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../ui/json-request.ts";
import { createProjectsApi } from "./api.ts";

function recorder(body: unknown = {}) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, api: createProjectsApi(fetchImpl) };
}

describe("the project list's calls", () => {
  // CR-34-T04
  it("activates a repository with PUT on its project route", async () => {
    const { api, calls } = recorder({ active: true });

    const result = await api.setActive("repo-1", true);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        url: "/api/repositories/repo-1/project",
        method: "PUT",
        body: '{"active":true}',
      },
    ]);
  });

  // CR-34-T04
  it("deactivates a repository with the same route and active false", async () => {
    const { api, calls } = recorder();

    await api.setActive("repo-1", false);

    expect(calls[0]?.body).toBe('{"active":false}');
  });

  it("escapes the repository id in the address", async () => {
    const { api, calls } = recorder();

    await api.setActive("a/b?c", true);

    expect(calls[0]?.url).toBe("/api/repositories/a%2Fb%3Fc/project");
  });

  // CR-21-T03
  it("runs the sync with POST and no body", async () => {
    const { api, calls } = recorder({ added: 1, errors: [] });

    const result = await api.sync();

    expect(result).toEqual({ ok: true, data: { added: 1, errors: [] } });
    expect(calls).toEqual([
      { url: "/api/integrations/sync", method: "POST", body: null },
    ]);
  });
});
