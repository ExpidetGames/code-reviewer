// SPDX-License-Identifier: Apache-2.0

// Pins down how backup files are named and recognized: a UTC timestamp in the name is the only thing
// rotation trusts (not the file's modification time), and a file that does not match the pattern is
// never treated as a backup.
import { describe, expect, it } from "vitest";
import { backupFileName, parseBackupFileName } from "./names.ts";

describe("backup file names", () => {
  // CR-40-T01
  it("writes the UTC time down to the second into the name", () => {
    const at = new Date("2026-10-10T02:30:05.123Z");

    expect(backupFileName(at, 1)).toBe("code-reviewer-20261010T023005Z.db");
  });

  // CR-40-T09
  it("adds a sequence number when the name is already taken", () => {
    const at = new Date("2026-10-10T02:30:05Z");

    expect(backupFileName(at, 2)).toBe("code-reviewer-20261010T023005Z-2.db");
  });

  // CR-40-T06
  it("reads time and sequence back from a name", () => {
    expect(parseBackupFileName("code-reviewer-20261010T023005Z.db")).toEqual({
      at: new Date("2026-10-10T02:30:05Z"),
      sequence: 1,
    });
    expect(parseBackupFileName("code-reviewer-20261010T023005Z-3.db")).toEqual({
      at: new Date("2026-10-10T02:30:05Z"),
      sequence: 3,
    });
  });

  // CR-40-T06
  it("does not recognize names that only look similar", () => {
    for (const name of [
      "notes.txt",
      "app.db",
      "code-reviewer-20261010T023005Z.db.tmp",
      ".code-reviewer-1a2b3c.tmp",
      "code-reviewer-20261310T023005Z.db",
      "code-reviewer-20261010T253005Z.db",
      "code-reviewer-20261010T023005Z-0.db",
      "my-code-reviewer-20261010T023005Z.db",
      "code-reviewer-20261010T023005Z.db\n",
    ]) {
      expect(parseBackupFileName(name), name).toBeNull();
    }
  });
});
