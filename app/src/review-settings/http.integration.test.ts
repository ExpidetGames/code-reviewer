// Pins down the handlers behind the review settings routes: the user is asked for first, a change is
// checked for where it comes from, its content type, size and shape, the answer carries the settings
// and their sources, and every refusal is a stable error code (an invalid setting adds the fields).
// The user check is injected so this test needs no session; the proxy in front of the real routes is
// tested in integration-tests/http/review-settings-route.integration.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import {
  REVIEW_SETTINGS_REQUEST_MAX_BYTES,
  createReviewSettingsRouteHandlers,
} from "./http.ts";

const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;
const URL_BASE = "https://app.test";

async function setup(
  requireUser: () => Promise<SessionUser> = async () => USER,
) {
  const app = await setupReviewSettings();
  await app.projects.activate(app.first.id);
  const handlers = createReviewSettingsRouteHandlers({
    requireUser,
    service: app.service,
  });
  const json = (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
  ) =>
    new Request(`${URL_BASE}${path}`, {
      method,
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const projectPath = `/api/repositories/${app.first.id}/project/settings`;
  return {
    ...app,
    handlers,
    projectPath,
    putGlobal: (body: unknown, headers?: Record<string, string>) =>
      handlers.putGlobal(json("PUT", "/api/review-settings", body, headers)),
    putProject: (
      body: unknown,
      headers?: Record<string, string>,
      repositoryId = app.first.id,
    ) =>
      handlers.putProject(
        json("PUT", projectPath, body, headers),
        repositoryId,
      ),
  };
}

describe("reading the settings over HTTP", () => {
  it("answers the global settings with their sources, the cost guard and the limits, never cached", async () => {
    const app = await setup();

    const response = await app.handlers.getGlobal(
      new Request(`${URL_BASE}/api/review-settings`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      overrides: {},
      effective: { model: "deepseek/deepseek-v3.2", maxTokens: 100_000 },
      cost: { warn: false, limitUsd: 0.1 },
      limits: { maxFindings: { min: 1, max: 30 } },
      updatedAt: null,
    });
  });

  it("answers the settings of a project with what it inherits", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, { maxFindings: 2 });

    const response = await app.handlers.getProject(
      new Request(`${URL_BASE}${app.projectPath}`),
      app.first.id,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repositoryId: app.first.id,
      overrides: { maxFindings: 2 },
      effective: { maxFindings: 2 },
      inherited: { maxFindings: 5 },
      sources: { maxFindings: "project", model: "built_in" },
    });
  });

  it("answers 404 PROJECT_NOT_FOUND for a repository without a project", async () => {
    const app = await setup();

    const response = await app.handlers.getProject(
      new Request(
        `${URL_BASE}/api/repositories/${app.second.id}/project/settings`,
      ),
      app.second.id,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
    });
  });
});

describe("changing the settings over HTTP", () => {
  it("saves the global defaults for the signed in person and answers the new state", async () => {
    const app = await setup();

    const response = await app.putGlobal({ settings: { maxFindings: 9 } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      overrides: { maxFindings: 9 },
      effective: { maxFindings: 9 },
      updatedBy: "octocat",
    });
    expect(await app.appSettingRows()).toMatchObject([
      { updated_by: "octocat" },
    ]);
  });

  it("saves the overrides of a project and resets them with DELETE", async () => {
    const app = await setup();

    const saved = await app.putProject({
      settings: { maxFindings: 2, inlineKeyIssues: true },
    });
    const reset = await app.handlers.deleteProject(
      new Request(`${URL_BASE}${app.projectPath}`, { method: "DELETE" }),
      app.first.id,
    );

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      overrides: { maxFindings: 2, inlineKeyIssues: true },
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ overrides: {} });
    expect((await app.projects.get(app.first.id))?.settings).toEqual({});
  });

  // CR-25-T07, CR-25-T08
  it("answers 400 with the wrong fields and stores nothing for invalid settings", async () => {
    const app = await setup();

    const response = await app.putProject({
      settings: {
        maxFindings: 0,
        extraInstructions: "x".repeat(4001),
        model: "",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "maxFindings", code: "TOO_SMALL" },
        { field: "extraInstructions", code: "TOO_LONG" },
        { field: "model", code: "EMPTY" },
      ],
    });
    expect((await app.projects.get(app.first.id))?.settings).toEqual({});
  });

  it("answers 400 REQUEST_INVALID for a body that is not JSON or has no settings object", async () => {
    const app = await setup();

    for (const body of ["not json", "[]", "{}", '{"maxFindings": 3}', "null"]) {
      const response = await app.putGlobal(body);
      expect(response.status, body).toBe(400);
      expect(await response.json()).toEqual({
        error: "REVIEW_SETTINGS_REQUEST_INVALID",
      });
    }
    expect(await app.appSettingRows()).toEqual([]);
  });

  it("answers 400 INVALID for a settings value that is not an object", async () => {
    const app = await setup();

    const response = await app.putGlobal({ settings: [1, 2] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "settings", code: "INVALID_TYPE" }],
    });
  });

  it("answers 415 for a body that is not application/json", async () => {
    const app = await setup();

    const response = await app.putGlobal('{"settings":{}}', {
      "content-type": "text/plain",
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_CONTENT_TYPE_UNSUPPORTED",
    });
  });

  it("answers 413 for a body over the limit, whether or not it declares its length", async () => {
    const app = await setup();
    const big = JSON.stringify({
      settings: {
        extraInstructions: "x".repeat(REVIEW_SETTINGS_REQUEST_MAX_BYTES),
      },
    });

    const response = await app.putGlobal(big);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_BODY_TOO_LARGE",
    });
    expect(await app.appSettingRows()).toEqual([]);
  });

  it.each<Record<string, string>>([
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { origin: "https://evil.test", host: "app.test" },
  ])(
    "answers 403 to a change that comes from another site (%j), for all three changes",
    async (extra) => {
      const app = await setup();
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...extra,
      };

      const responses = [
        await app.putGlobal({ settings: { maxFindings: 9 } }, headers),
        await app.putProject({ settings: { maxFindings: 9 } }, headers),
        await app.handlers.deleteProject(
          new Request(`${URL_BASE}${app.projectPath}`, {
            method: "DELETE",
            headers,
          }),
          app.first.id,
        ),
      ];

      for (const response of responses) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "REVIEW_SETTINGS_CROSS_SITE_REQUEST",
        });
      }
      expect(await app.appSettingRows()).toEqual([]);
      expect((await app.projects.get(app.first.id))?.settings).toEqual({});
    },
  );

  it("answers 404 when saving or resetting the settings of a repository without a project", async () => {
    const app = await setup();

    const saved = await app.putProject(
      { settings: { maxFindings: 3 } },
      undefined,
      app.second.id,
    );
    const reset = await app.handlers.deleteProject(
      new Request(`${URL_BASE}/x`, { method: "DELETE" }),
      app.second.id,
    );

    expect(saved.status).toBe(404);
    expect(reset.status).toBe(404);
  });
});

describe("the user check", () => {
  it("runs first, before the body is read or the database is touched", async () => {
    const stop = new Error("NEXT_REDIRECT");
    const requireUser = vi.fn().mockRejectedValue(stop);
    const app = await setup(requireUser);
    const request = new Request(`${URL_BASE}/api/review-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { maxFindings: 9 } }),
    });

    await expect(app.handlers.putGlobal(request)).rejects.toBe(stop);

    expect(request.bodyUsed).toBe(false);
    expect(await app.appSettingRows()).toEqual([]);
    for (const call of [
      app.handlers.getGlobal(new Request(`${URL_BASE}/api/review-settings`)),
      app.handlers.getProject(new Request(`${URL_BASE}/x`), app.first.id),
      app.handlers.putProject(request.clone(), app.first.id),
      app.handlers.deleteProject(
        new Request(`${URL_BASE}/x`, { method: "DELETE" }),
        app.first.id,
      ),
    ])
      await expect(call).rejects.toBe(stop);
  });
});
