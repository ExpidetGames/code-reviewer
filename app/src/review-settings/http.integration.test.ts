// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the handlers behind the review settings routes: the user is asked for first, a change is
// checked for where it comes from, its content type, size and shape, the answer carries the settings
// and their sources, and every refusal is a stable error code (an invalid setting adds the fields).
// The user check is injected so this test needs no session; the proxy in front of the real routes is
// tested in integration-tests/http/review-settings-route.integration.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import {
  createModelCapabilityChecker,
  type ModelCapabilityChecker,
} from "../llm/model-capabilities.ts";
import { llmProviderDescriptors } from "../llm/providers/index.ts";
import { cleanUpAfterTest } from "../test-support/test-database.ts";
import { setupReviewSettings } from "../test-support/review-settings-harness.ts";
import {
  REVIEW_SETTINGS_REQUEST_MAX_BYTES,
  createReviewSettingsRouteHandlers,
} from "./http.ts";

const OTHER_PROVIDER = llmProviderDescriptors.ids.find(
  (id) => id !== llmProviderDescriptors.defaultProvider.id,
)!;
const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;
const URL_BASE = "https://app.test";

async function setup(
  requireUser: () => Promise<SessionUser> = async () => USER,
  modelCapabilities?: ModelCapabilityChecker,
) {
  const app = await setupReviewSettings(
    undefined,
    modelCapabilities === undefined ? {} : { modelCapabilities },
  );
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

  it("answers 404 PROJECT_NOT_FOUND for a repository that does not exist", async () => {
    const app = await setup();

    const response = await app.handlers.getProject(
      new Request(`${URL_BASE}/api/repositories/nope/project/settings`),
      "nope",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_PROJECT_NOT_FOUND",
    });
  });

  // #80
  it("answers the defaults for a repository that was never activated", async () => {
    const app = await setup();

    const response = await app.handlers.getProject(
      new Request(
        `${URL_BASE}/api/repositories/${app.second.id}/project/settings`,
      ),
      app.second.id,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repositoryId: app.second.id,
      projectId: null,
      active: false,
      overrides: {},
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

  it("answers 404 when saving or resetting the settings of a repository that does not exist", async () => {
    const app = await setup();

    const saved = await app.putProject(
      { settings: { maxFindings: 3 } },
      undefined,
      "nope",
    );
    const reset = await app.handlers.deleteProject(
      new Request(`${URL_BASE}/x`, { method: "DELETE" }),
      "nope",
    );

    expect(saved.status).toBe(404);
    expect(reset.status).toBe(404);
  });

  // #80
  it("saves the settings of a repository that was never activated and leaves it inactive", async () => {
    const app = await setup();

    const saved = await app.putProject(
      { settings: { maxFindings: 3 } },
      undefined,
      app.second.id,
    );

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      active: false,
      overrides: { maxFindings: 3 },
    });
    expect(
      await app.projects.findActiveForRepository(app.second.id),
    ).toBeUndefined();
  });
});

describe("the project-only settings over HTTP", () => {
  // #194-T03
  it("saves and reloads Dynamic settings and exposes the defaults, sources and limits", async () => {
    const app = await setup();

    const saved = await app.putProject({
      settings: {
        reviewKind: "dynamic",
        dynamicModel: "vendor/dynamic-model",
        reviewSkill: "Review this pull request dynamically.",
      },
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      dynamic: {
        effective: {
          reviewKind: "dynamic",
          dynamicModel: "vendor/dynamic-model",
          reviewSkill: "Review this pull request dynamically.",
        },
        sources: { reviewKind: "project", dynamicModel: "project" },
        limits: { reviewSkillMaxBytes: 16_384 },
      },
    });

    const read = await app.handlers.getProject(
      new Request(`${URL_BASE}${app.projectPath}`),
      app.first.id,
    );
    expect(await read.json()).toMatchObject({
      dynamic: {
        effective: {
          reviewKind: "dynamic",
          dynamicModel: "vendor/dynamic-model",
        },
      },
    });
  });

  // #405-T28
  it("saves the verdict mode and reads it back, and refuses an unknown one with a stable code", async () => {
    const app = await setup();

    const saved = await app.putProject({ settings: { reviewVerdict: "off" } });
    const refused = await app.putProject({
      settings: { reviewVerdict: "always" },
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      dynamic: {
        effective: { reviewVerdict: "off" },
        defaults: { reviewVerdict: "blocking" },
        sources: { reviewVerdict: "project" },
      },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "reviewVerdict", code: "INVALID_FORMAT" }],
    });
    const read = await app.handlers.getProject(
      new Request(`${URL_BASE}${app.projectPath}`),
      app.first.id,
    );
    expect(await read.json()).toMatchObject({
      dynamic: { effective: { reviewVerdict: "off" } },
    });
  });

  // #676-T01
  it("is a workspace default: the global route stores the verdict mode and shows it as the default of a project", async () => {
    const app = await setup();

    const response = await app.putGlobal({
      settings: { reviewVerdict: "any" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dynamic: {
        overrides: { reviewVerdict: "any" },
        effective: { reviewVerdict: "any" },
      },
    });
    const project = await app.handlers.getProject(
      new Request(`${URL_BASE}${app.projectPath}`),
      app.first.id,
    );
    expect(await project.json()).toMatchObject({
      dynamic: {
        effective: { reviewVerdict: "any" },
        defaults: { reviewVerdict: "any" },
        sources: { reviewVerdict: "global" },
      },
    });
  });

  // #194-T05
  it("refuses an oversize skill with a stable code and never echoes the value", async () => {
    const app = await setup();
    const sentinel = "skill-sentinel-should-not-be-echoed";
    const oversize = `${sentinel}${"ü".repeat(9_000)}`;

    const response = await app.putProject({
      settings: { reviewSkill: oversize },
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "reviewSkill", code: "TOO_LONG" }],
    });
    expect(text).not.toContain(sentinel);
    expect((await app.projects.get(app.first.id))?.settings).toEqual({});
  });

  // #676-T07
  it("keeps the review skill a project's: the global route refuses it, and the address a project pins", async () => {
    const app = await setup();

    const response = await app.putGlobal({
      settings: { reviewSkill: "my skill", confirmProviderAddress: true },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "confirmProviderAddress", code: "UNKNOWN_FIELD" },
        { field: "reviewSkill", code: "UNKNOWN_FIELD" },
      ],
    });
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #676-T07
  it("offers the providers of the registry only as the Dynamic default: a catalog provider is a project's choice", async () => {
    const app = await setup();

    const response = await app.putGlobal({
      settings: { dynamicProvider: "zhipuai", dynamicModel: "glm-4.5" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "dynamicProvider", code: "PROVIDER_UNKNOWN" }],
    });
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #676-T07
  it("names an unknown review kind of the defaults", async () => {
    const app = await setup();

    const response = await app.putGlobal({ settings: { reviewKind: "both" } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [{ field: "reviewKind", code: "INVALID_FORMAT" }],
    });
    expect(await app.appSettingRows()).toEqual([]);
  });

  // #194-T05
  it("refuses a cross-site Dynamic save without echoing the skill", async () => {
    const app = await setup();
    const sentinel = "skill-sentinel-cross-site";

    const response = await app.putProject(
      { settings: { reviewSkill: sentinel } },
      { "content-type": "application/json", "sec-fetch-site": "cross-site" },
    );
    const text = await response.text();

    expect(response.status).toBe(403);
    expect(JSON.parse(text)).toEqual({
      error: "REVIEW_SETTINGS_CROSS_SITE_REQUEST",
    });
    expect(text).not.toContain(sentinel);
    expect((await app.projects.get(app.first.id))?.settings).toEqual({});
  });
});

// #676: the review of #679, over HTTP.
describe("saving the workspace defaults over HTTP, against a stale form and a project it would break", () => {
  it("answers 409 REVIEW_SETTINGS_STALE for defaults that were saved since the form was read, and stores nothing of it", async () => {
    const app = await setup();
    await app.putGlobal({ settings: { maxFindings: 9 } });

    const stale = await app.putGlobal({
      settings: { maxFindings: 7 },
      expectedUpdatedAt: null,
    });

    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "REVIEW_SETTINGS_STALE" });
    const current = (await (
      await app.handlers.getGlobal(
        new Request(`${URL_BASE}/api/review-settings`),
      )
    ).json()) as { updatedAt: string; overrides: unknown };
    expect(current.overrides).toEqual({ maxFindings: 9 });

    const fresh = await app.putGlobal({
      settings: { maxFindings: 7 },
      expectedUpdatedAt: current.updatedAt,
    });
    expect(fresh.status).toBe(200);
  });

  it("answers 400 REQUEST_INVALID for an expected time that is neither a text nor null", async () => {
    const app = await setup();

    const response = await app.putGlobal({
      settings: {},
      expectedUpdatedAt: 5,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_REQUEST_INVALID",
    });
  });

  it("names the projects a provider change would break, beside the issue", async () => {
    const app = await setup();
    await app.service.updateProjectSettings(app.first.id, {
      dynamicModel: "vendor/own-model",
    });

    const response = await app.putGlobal({
      settings: { dynamicProvider: OTHER_PROVIDER },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "dynamicProvider", code: "PROJECT_MODEL_BOUND_TO_PROVIDER" },
      ],
      projects: [app.first.fullName],
    });
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

// #269-T05 #269-T07
describe("the check of the Dynamic model over HTTP", () => {
  async function setupChecked(baseUrl?: string) {
    const llm = await startLlmFake();
    cleanUpAfterTest(() => llm.close());
    const checker = createModelCapabilityChecker({
      baseUrl: () => baseUrl ?? llm.baseUrl,
      log: () => undefined,
      timeoutMs: 1000,
    });
    return { llm, app: await setup(async () => USER, checker) };
  }

  it("refuses a model without tool support with 400 and the code on the field", async () => {
    const { llm, app } = await setupChecked();
    llm.setModel("vendor/no-tools", [{ supported_parameters: ["tools"] }]);

    const response = await app.putProject({
      settings: { dynamicModel: "vendor/no-tools" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "REVIEW_SETTINGS_INVALID",
      issues: [
        { field: "dynamicModel", code: "DYNAMIC_MODEL_TOOLS_UNSUPPORTED" },
      ],
    });
  });

  it("answers a save that could not be checked with 200 and the warning", async () => {
    const { app } = await setupChecked("http://127.0.0.1:1/api/v1");

    const response = await app.putProject({
      settings: { dynamicModel: "vendor/any" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dynamic: { effective: { dynamicModel: "vendor/any" } },
      warnings: [{ field: "dynamicModel", code: "DYNAMIC_MODEL_UNVERIFIED" }],
    });
  });
});

// #283: the routes of a workspace on the operator's key carry no model.
describe("the settings routes of a workspace on the operator's key", () => {
  async function managed() {
    const app = await setupReviewSettings(undefined, {
      operatorsModels: true,
    });
    await app.projects.activate(app.first.id);
    const handlers = createReviewSettingsRouteHandlers({
      requireUser: async () => USER,
      service: app.service,
    });
    const put = (path: string, body: unknown) =>
      new Request(`${URL_BASE}${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const projectPath = `/api/repositories/${app.first.id}/project/settings`;
    return { ...app, handlers, put, projectPath };
  }

  // #283-T07
  it("answer no model field and no model name, for the defaults and a project", async () => {
    const app = await managed();

    const responses = [
      await app.handlers.getGlobal(
        new Request(`${URL_BASE}/api/review-settings`),
      ),
      await app.handlers.getProject(
        new Request(`${URL_BASE}${app.projectPath}`),
        app.first.id,
      ),
    ];

    const bodies: unknown[] = [];
    for (const response of responses) {
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toMatch(/"(model|fallbackModel|dynamicModel)"/);
      expect(text).not.toContain("deepseek");
      bodies.push(JSON.parse(text));
    }
    for (const body of bodies)
      expect(body).toMatchObject({ modelManagedByInstance: true, cost: null });
  });

  // #434-T03
  it("refuse the old quality level at the defaults and at a project with 400 and UNKNOWN_FIELD", async () => {
    const app = await managed();
    const legacy = ["model", "Tier"].join("");

    const global = await app.handlers.putGlobal(
      app.put("/api/review-settings", { settings: { [legacy]: "low" } }),
    );
    const project = await app.handlers.putProject(
      app.put(app.projectPath, { settings: { [legacy]: "high" } }),
      app.first.id,
    );

    for (const response of [global, project]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "REVIEW_SETTINGS_INVALID",
        issues: [{ field: legacy, code: "UNKNOWN_FIELD" }],
      });
    }
  });

  // #283-T04
  it.each([
    ["model", { model: "acme-x/y-1" }],
    ["fallbackModel", { fallbackModel: "acme-x/y-1" }],
  ])(
    "refuse %s in a write of the defaults with 400 and the code MODEL_MANAGED_BY_INSTANCE",
    async (field, settings) => {
      const app = await managed();

      const response = await app.handlers.putGlobal(
        app.put("/api/review-settings", { settings }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "REVIEW_SETTINGS_INVALID",
        issues: [{ field, code: "MODEL_MANAGED_BY_INSTANCE" }],
      });
      expect(await app.appSettingRows()).toEqual([]);
    },
  );

  // #283-T04
  it.each([
    ["model", { model: "acme-x/y-1" }],
    ["dynamicModel", { dynamicModel: "acme-x/y-1" }],
  ])(
    "refuse %s in a write of a project with 400 and the code MODEL_MANAGED_BY_INSTANCE",
    async (field, settings) => {
      const app = await managed();

      const response = await app.handlers.putProject(
        app.put(app.projectPath, { settings }),
        app.first.id,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "REVIEW_SETTINGS_INVALID",
        issues: [{ field, code: "MODEL_MANAGED_BY_INSTANCE" }],
      });
    },
  );

  // #283-T02
  it("leave a workspace on its own key as before: the model is answered and accepted", async () => {
    const app = await setup();

    const response = await app.putProject({
      settings: { model: "acme-x/y-1" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      effective: { model: "acme-x/y-1" },
      modelManagedByInstance: false,
    });
  });

  // #283-T09
  it("show an instance admin on a workspace with its own key everything they showed before", async () => {
    const admin = {
      id: "admin",
      githubLogin: "operator",
      isInstanceAdmin: true,
    } as unknown as SessionUser;
    const app = await setup(async () => admin);

    const read = await app.handlers.getProject(
      new Request(`${URL_BASE}${app.projectPath}`),
      app.first.id,
    );
    const saved = await app.putProject({
      settings: { model: "acme-x/y-1", maxFindings: 3 },
    });

    expect(await read.json()).toMatchObject({
      effective: { model: "deepseek/deepseek-v3.2" },
      dynamic: { effective: { dynamicModel: expect.any(String) } },
      cost: { warn: false },
      modelManagedByInstance: false,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      overrides: { model: "acme-x/y-1", maxFindings: 3 },
    });
  });

  // #283-T09
  it("give an instance admin who is a member of a workspace on the operator's key the same view as its members", async () => {
    const admin = {
      id: "admin",
      githubLogin: "operator",
      isInstanceAdmin: true,
    } as unknown as SessionUser;
    const app = await setupReviewSettings(undefined, {
      operatorsModels: true,
    });
    const handlers = createReviewSettingsRouteHandlers({
      requireUser: async () => admin,
      service: app.service,
    });

    const response = await handlers.getGlobal(
      new Request(`${URL_BASE}/api/review-settings`),
    );

    // The operator reads the models through the operator API and the instance portal, not through a workspace.
    expect(await response.text()).not.toMatch(/"model"|deepseek/);
  });
});

// The right to move the pin of a catalog provider's address (#588) comes from the route (`canManageLlmKey`, from the role). A
// handler built without it must not grant it: the default is the fail-closed one (#614).
describe("the right to confirm the address of a catalog provider, as the handlers get it", () => {
  const TRUSTED = { address: "https://api.deepseek.example" };
  const SELECT = {
    reviewKind: "dynamic",
    dynamicProvider: "deepseek",
    dynamicModel: "deepseek-v4-pro",
  };

  async function pinnedThenMoved(canManageLlmKey?: boolean) {
    const app = await setupReviewSettings(undefined, {
      nativeCatalog: {
        addressOf: () => Promise.resolve(TRUSTED.address),
        checkSelection: (_slug, modelId) =>
          Promise.resolve({
            ok: true,
            model: {
              id: modelId,
              name: modelId,
              contextTokens: 128_000,
              outputTokens: 8_000,
              reasoning: false,
              deprecated: false,
              alpha: false,
              price: null,
            },
          }),
      },
    });
    await app.projects.activate(app.first.id);
    await app.service.updateProjectSettings(app.first.id, SELECT);
    TRUSTED.address = "https://api.deepseek-moved.example";
    const handlers = createReviewSettingsRouteHandlers({
      requireUser: async () => USER,
      service: app.service,
      ...(canManageLlmKey === undefined ? {} : { canManageLlmKey }),
    });
    const request = (method: string, body?: unknown) =>
      new Request(
        `${URL_BASE}/api/repositories/${app.first.id}/project/settings`,
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    const pin = async () =>
      (
        JSON.parse((await app.projectRows())[0]!.settings) as {
          dynamicProviderAddress?: string;
        }
      ).dynamicProviderAddress;
    return { app, handlers, request, pin };
  }

  // #614-T03
  it("refuses a confirmation and a reset with 403 when the route passes no right, and stores nothing", async () => {
    TRUSTED.address = "https://api.deepseek.example";
    const t = await pinnedThenMoved();

    const confirm = await t.handlers.putProject(
      t.request("PUT", { settings: { confirmProviderAddress: true } }),
      t.app.first.id,
    );
    const reset = await t.handlers.deleteProject(
      t.request("DELETE"),
      t.app.first.id,
    );

    for (const response of [confirm, reset]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "PROVIDER_ADDRESS_CONFIRM_FORBIDDEN",
      });
    }
    expect(await t.pin()).toBe("https://api.deepseek.example");
  });

  // #614-T03
  it("lets the same requests through when the route passes the right", async () => {
    TRUSTED.address = "https://api.deepseek.example";
    const t = await pinnedThenMoved(true);

    const confirm = await t.handlers.putProject(
      t.request("PUT", { settings: { confirmProviderAddress: true } }),
      t.app.first.id,
    );

    expect(confirm.status).toBe(200);
    expect(await t.pin()).toBe("https://api.deepseek-moved.example");
  });
});
