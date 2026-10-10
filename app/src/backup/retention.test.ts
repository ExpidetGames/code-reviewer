// Pins down the retention rule: 7 daily and 4 weekly backups, counted in days and weeks that have a
// backup (a gap in the history never deletes the history), with the newest backup and everything
// younger than a day always kept. The rule is a pure function of the file names and the clock.
import { describe, expect, it } from "vitest";
import { backupFileName } from "./names.ts";
import { DEFAULT_RETENTION, planRotation } from "./retention.ts";

const NOW = new Date("2026-10-31T03:00:00Z");

function nameAt(iso: string, sequence = 1): string {
  return backupFileName(new Date(iso), sequence);
}

/** One backup per day at 02:30 UTC, `count` days ending on `last` (inclusive). */
function dailyBackups(last: string, count: number): string[] {
  const end = new Date(`${last}T02:30:00Z`);
  return Array.from({ length: count }, (_, index) =>
    backupFileName(new Date(end.getTime() - index * 86_400_000), 1),
  );
}

describe("retention", () => {
  // CR-40-T05
  it("proposes nothing for deletion while there are fewer backups than the rule keeps", () => {
    const names = dailyBackups("2026-10-31", 5);

    const plan = planRotation(names, NOW, DEFAULT_RETENTION);

    expect(plan.remove).toEqual([]);
    expect([...plan.keep].sort()).toEqual([...names].sort());
  });

  // CR-40-T05
  it("keeps seven daily backups and four weekly backups and proposes the rest", () => {
    // 60 consecutive days: the last 7 days are the dailies, the newest backup of each of the 4 most
    // recent weeks are the weeklies.
    const names = dailyBackups("2026-10-31", 60);

    const plan = planRotation(names, NOW, DEFAULT_RETENTION);

    const kept = new Set(plan.keep);
    for (const day of [
      "2026-10-31",
      "2026-10-30",
      "2026-10-29",
      "2026-10-28",
      "2026-10-27",
      "2026-10-26",
      "2026-10-25",
    ]) {
      expect(kept.has(nameAt(`${day}T02:30:00Z`)), day).toBe(true);
    }
    // Weeks start on Monday (UTC): 2026-10-26 is a Monday. The newest backup of each earlier week
    // is the one on its Sunday.
    for (const sunday of ["2026-10-25", "2026-10-18", "2026-10-11"]) {
      expect(kept.has(nameAt(`${sunday}T02:30:00Z`)), sunday).toBe(true);
    }
    expect(kept.has(nameAt("2026-10-04T02:30:00Z"))).toBe(false);
    expect(kept.has(nameAt("2026-10-20T02:30:00Z"))).toBe(false);
    expect(plan.keep.length + plan.remove.length).toBe(names.length);
    // The newest of the current week and of the previous week are daily backups already, so the
    // two older weeks add one each.
    expect(plan.keep).toHaveLength(7 + 2);
  });

  // CR-40-T05
  it("keeps only the newest backup of a day for the daily rule once a day is over", () => {
    const names = [
      nameAt("2026-10-20T01:00:00Z"),
      nameAt("2026-10-20T02:00:00Z"),
      nameAt("2026-10-20T03:00:00Z"),
      nameAt("2026-10-31T02:30:00Z"),
    ];

    const plan = planRotation(names, NOW, DEFAULT_RETENTION);

    expect(plan.keep).toContain(nameAt("2026-10-20T03:00:00Z"));
    expect(plan.remove.sort()).toEqual([
      nameAt("2026-10-20T01:00:00Z"),
      nameAt("2026-10-20T02:00:00Z"),
    ]);
  });

  // CR-40-T05
  it("counts days that have a backup, so a long gap does not delete the history", () => {
    const names = [
      nameAt("2026-08-01T02:30:00Z"),
      nameAt("2026-08-02T02:30:00Z"),
      nameAt("2026-08-03T02:30:00Z"),
    ];

    const plan = planRotation(names, NOW, DEFAULT_RETENTION);

    expect(plan.remove).toEqual([]);
  });

  // CR-40-T09
  it("keeps every backup younger than a day, so two backups in one minute both survive", () => {
    const names = [
      nameAt("2026-10-31T02:30:05Z"),
      nameAt("2026-10-31T02:30:05Z", 2),
      nameAt("2026-10-31T02:30:40Z"),
    ];

    const plan = planRotation(names, NOW, DEFAULT_RETENTION);

    expect(plan.remove).toEqual([]);
  });

  // CR-40-T06
  it("never touches files whose name does not match the backup pattern", () => {
    const names = [
      "README.txt",
      "app.db",
      ".code-reviewer-abc.tmp",
      "code-reviewer-20261010T023005Z.db.bak",
      nameAt("2026-10-31T02:30:00Z"),
    ];

    const plan = planRotation(names, NOW, DEFAULT_RETENTION);

    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([nameAt("2026-10-31T02:30:00Z")]);
  });

  // CR-40-T06
  it("never proposes the newest backup, even when it is the only one and older than the retention", () => {
    const only = nameAt("2025-01-01T02:30:00Z");

    const plan = planRotation([only], NOW, DEFAULT_RETENTION);

    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([only]);
  });

  // CR-40-T06
  it("keeps the newest backup of a pair taken in the same second", () => {
    const first = nameAt("2025-01-01T02:30:00Z");
    const second = nameAt("2025-01-01T02:30:00Z", 2);

    const plan = planRotation([first, second], NOW, DEFAULT_RETENTION);

    expect(plan.keep).toEqual([second]);
    expect(plan.remove).toEqual([first]);
  });

  it("proposes nothing for an empty directory", () => {
    expect(planRotation([], NOW, DEFAULT_RETENTION)).toEqual({
      keep: [],
      remove: [],
    });
  });
});
