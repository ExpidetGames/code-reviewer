// How backup files are named. The UTC time in the name is the only thing rotation reads, never the
// file's modification time (a copy or a restore of the directory would change that).
//
//   code-reviewer-20261010T023005Z.db      the backup taken at 2026-10-10 02:30:05 UTC
//   code-reviewer-20261010T023005Z-2.db    a second one in the same second
const PATTERN =
  /^code-reviewer-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-([1-9]\d*))?\.db$/;

// "code-reviewer-" plus "YYYYMMDDTHHMMSSZ".
const STAMP_LENGTH = 30;

/** Files that a backup run is still writing; they never match the backup pattern. */
export const TEMP_FILE_PREFIX = ".code-reviewer-";
export const TEMP_FILE_SUFFIX = ".tmp";

export type ParsedBackupName = {
  at: Date;
  /** 1 for the first backup of a second, 2 for the next, and so on. */
  sequence: number;
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function backupFileName(at: Date, sequence: number): string {
  const stamp =
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  return `code-reviewer-${stamp}${sequence > 1 ? `-${String(sequence)}` : ""}.db`;
}

/** The time and sequence of a backup file name, or null for any other name. */
export function parseBackupFileName(name: string): ParsedBackupName | null {
  const match = PATTERN.exec(name);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls over (month 13 becomes January): only a name that survives the round trip is real.
  if (
    backupFileName(at, 1).slice(0, STAMP_LENGTH) !== name.slice(0, STAMP_LENGTH)
  )
    return null;
  return { at, sequence: match[7] === undefined ? 1 : Number(match[7]) };
}

export function isTempFileName(name: string): boolean {
  return name.startsWith(TEMP_FILE_PREFIX) && name.endsWith(TEMP_FILE_SUFFIX);
}
