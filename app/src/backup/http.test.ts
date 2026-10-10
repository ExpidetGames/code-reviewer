// Pins down the status handler: the user is asked for first and nothing is read for a caller without
// a session, the answer is never cached, and a broken setting is a stable error code.
import { describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../auth/access-policy.ts";
import { BackupError } from "./errors.ts";
import { createBackupStatusHandler } from "./http.ts";
import type { BackupStatus } from "./status.ts";

const USER = { id: "u1", githubLogin: "octocat" } as unknown as SessionUser;
const STATUS: BackupStatus = {
  schedule: { enabled: true, timeUtc: "02:30" },
  target: { usable: true, errorCode: null },
  lastRun: null,
  newestBackup: null,
  backupCount: 0,
  stale: true,
};

describe("the backup status handler", () => {
  it("answers with the status and forbids caching", async () => {
    const handler = createBackupStatusHandler({
      requireUser: async () => USER,
      readStatus: () => STATUS,
    });

    const response = await handler();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(STATUS);
  });

  it("reads nothing when there is no signed in user", async () => {
    const readStatus = vi.fn(() => STATUS);
    const handler = createBackupStatusHandler({
      requireUser: async () => {
        throw new Error("redirect to login");
      },
      readStatus,
    });

    await expect(handler()).rejects.toThrow("redirect to login");
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("answers with a stable error code when the settings are invalid", async () => {
    const handler = createBackupStatusHandler({
      requireUser: async () => USER,
      readStatus: () => {
        throw new BackupError("BACKUP_CONFIG_INVALID", "BACKUP_TIME is wrong");
      },
    });

    const response = await handler();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "BACKUP_CONFIG_INVALID" });
  });
});
