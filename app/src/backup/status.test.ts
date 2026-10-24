// SPDX-License-Identifier: LicenseRef-Proprietary

// The backup status of a Postgres instance: the app does not back up an external database, so the
// status says backups are not applicable instead of showing a schedule or a target.
import { describe, expect, it } from "vitest";
import { loadBackupConfig } from "./config.ts";
import { readBackupStatus } from "./status.ts";

describe("the backup status of a Postgres instance", () => {
  // #105-PG-13
  it("reports that backups are not applicable and reads no directory", () => {
    const config = loadBackupConfig({
      DATABASE_URL: "postgres://user:secret@db:5432/app",
    });

    expect(config.applies).toBe(false);
    expect(
      readBackupStatus({ config, lastRun: null, now: new Date() }),
    ).toEqual({
      applicable: false,
      schedule: { enabled: false, timeUtc: null },
      target: { usable: false, errorCode: null },
      lastRun: null,
      newestBackup: null,
      backupCount: 0,
      stale: false,
    });
  });
});
