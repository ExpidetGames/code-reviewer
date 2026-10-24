// SPDX-License-Identifier: LicenseRef-Proprietary

// The daily repository sync of a serverless deployment (#319): the platform's cron calls it with the
// shared secret, it runs the same full sync the server runs at start, and it answers with counts only.
// Outside serverless mode the route does not exist, and without the right secret it grants nothing.
import { describe, expect, it, vi } from "vitest";
import type { SyncSummary } from "../integrations/sync/service.ts";
import { handleRepositorySyncCron } from "./repository-sync.ts";

const SECRET = "cron-secret-0123456789abcdef0123456789abcdef";
const serverlessEnv = { APP_RUNTIME: "serverless", CRON_SECRET: SECRET };

const summary: SyncSummary = {
  integrations: { created: 1, updated: 2, enabled: 0, disabled: 0 },
  repositories: { added: 3, reactivated: 1, deactivated: 0 },
  errors: [],
} as unknown as SyncSummary;

function request(authorization?: string): Request {
  return new Request(
    "https://reviews.example.test/api/internal/repository-sync",
    {
      headers: authorization === undefined ? {} : { authorization },
    },
  );
}

function deps(
  overrides: Partial<Parameters<typeof handleRepositorySyncCron>[1]> = {},
) {
  return {
    env: serverlessEnv,
    githubConfigured: async () => true,
    syncAll: vi.fn(async () => summary),
    ...overrides,
  };
}

describe("the daily repository sync", () => {
  // #319-T09
  it("runs the full sync for the platform's cron call and answers with counts only", async () => {
    const d = deps();

    const response = await handleRepositorySyncCron(
      request(`Bearer ${SECRET}`),
      d,
    );

    expect(response.status).toBe(200);
    expect(d.syncAll).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({
      status: "ok",
      integrations: { created: 1 },
      repositories: { added: 3, reactivated: 1, deactivated: 0 },
      errors: 0,
    });
  });

  // #319-T10
  it.each([
    ["no header", undefined],
    ["a wrong secret", "Bearer not-the-secret"],
    ["another scheme", `Basic ${SECRET}`],
  ])("answers 401 for %s and runs nothing", async (_, header) => {
    const d = deps();

    const response = await handleRepositorySyncCron(request(header), d);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "CRON_UNAUTHORIZED" });
    expect(d.syncAll).not.toHaveBeenCalled();
  });

  // #319-T10
  it("answers 401 for every caller while CRON_SECRET is missing or weak, even one that sends nothing useful", async () => {
    for (const secret of [undefined, "", "short"]) {
      const d = deps({
        env: { APP_RUNTIME: "serverless", CRON_SECRET: secret },
      });

      const response = await handleRepositorySyncCron(
        request(`Bearer ${secret ?? ""}`),
        d,
      );

      expect(response.status).toBe(401);
      expect(d.syncAll).not.toHaveBeenCalled();
    }
  });

  // #319-T11
  it("does not exist in server mode: 404 with the right secret as well", async () => {
    const d = deps({ env: { CRON_SECRET: SECRET } });

    const response = await handleRepositorySyncCron(
      request(`Bearer ${SECRET}`),
      d,
    );

    expect(response.status).toBe(404);
    expect(d.syncAll).not.toHaveBeenCalled();
  });

  // #319-T12
  it("skips an instance that is not connected to GitHub, as the server start does", async () => {
    const d = deps({ githubConfigured: async () => false });

    const response = await handleRepositorySyncCron(
      request(`Bearer ${SECRET}`),
      d,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "skipped",
      reason: "github_not_configured",
    });
    expect(d.syncAll).not.toHaveBeenCalled();
  });

  // #319-T13
  it("answers 500 with a stable code and no detail when the sync fails, so the cron shows a failure", async () => {
    const d = deps({
      syncAll: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED postgres://app:s3cr3t-pw@db/app");
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handleRepositorySyncCron(
      request(`Bearer ${SECRET}`),
      d,
    );

    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("REPOSITORY_SYNC_FAILED");
    expect(body).not.toContain("s3cr3t-pw");
  });

  // #319-T14
  it("counts the errors of a sync that finished with some, still as a finished run", async () => {
    const d = deps({
      syncAll: vi.fn(
        async () =>
          ({ ...summary, errors: ["a", "b"] }) as unknown as SyncSummary,
      ),
    });

    const response = await handleRepositorySyncCron(
      request(`Bearer ${SECRET}`),
      d,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ errors: 2 });
  });
});
