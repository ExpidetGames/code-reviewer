// Pins down the calls the settings form makes: which route, which method and which body, for the
// global defaults and for one project, including the reset of a project. The routes themselves are
// proven where they live (src/review-settings/http.integration.test.ts).
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../../ui/json-request.ts";
import { createGlobalSettingsApi, createProjectSettingsApi } from "./api.ts";

function recorder() {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("the settings form's calls", () => {
  // CR-34-T05
  it("saves the project settings with PUT, wrapped as settings", async () => {
    const { calls, fetchImpl } = recorder();

    await createProjectSettingsApi(fetchImpl, "repo-1").save({
      maxFindings: 7,
    });

    expect(calls).toEqual([
      {
        url: "/api/repositories/repo-1/project/settings",
        method: "PUT",
        body: '{"settings":{"maxFindings":7}}',
      },
    ]);
  });

  it("resets a project with DELETE on the same route", async () => {
    const { calls, fetchImpl } = recorder();

    await createProjectSettingsApi(fetchImpl, "repo-1").reset?.();

    expect(calls).toEqual([
      {
        url: "/api/repositories/repo-1/project/settings",
        method: "DELETE",
        body: null,
      },
    ]);
  });

  // CR-34-T08
  it("saves the global defaults with PUT on the review settings route and offers no reset", async () => {
    const { calls, fetchImpl } = recorder();
    const api = createGlobalSettingsApi(fetchImpl);

    await api.save({ model: "openai/gpt-5.4-mini" });

    expect(calls).toEqual([
      {
        url: "/api/review-settings",
        method: "PUT",
        body: '{"settings":{"model":"openai/gpt-5.4-mini"}}',
      },
    ]);
    expect(api.reset).toBeUndefined();
  });

  it("escapes the repository id in the address", async () => {
    const { calls, fetchImpl } = recorder();

    await createProjectSettingsApi(fetchImpl, "a/b").save({});

    expect(calls[0]?.url).toBe("/api/repositories/a%2Fb/project/settings");
  });
});
