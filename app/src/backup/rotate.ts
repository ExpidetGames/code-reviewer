// Applies the retention rule to a backup directory: lists it, asks `planRotation` what goes, and
// deletes exactly that. Anything that is not a backup file is neither listed nor touched.
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "./errors.ts";
import {
  DEFAULT_RETENTION,
  planRotation,
  type RetentionRule,
} from "./retention.ts";

export type RotationResult = {
  /** File names that were deleted. */
  removed: string[];
  /** File names that should have gone but could not be deleted, or a note on the listing. */
  failed: string[];
  /** The first error message, when there was one. */
  problem: string | null;
};

export function rotateBackups({
  backupDir,
  now,
  rule = DEFAULT_RETENTION,
}: {
  backupDir: string;
  now: Date;
  rule?: RetentionRule;
}): RotationResult {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch (error) {
    return { removed: [], failed: [], problem: describeError(error) };
  }

  const result: RotationResult = { removed: [], failed: [], problem: null };
  for (const name of planRotation(names, now, rule).remove) {
    try {
      unlinkSync(join(backupDir, name));
      result.removed.push(name);
    } catch (error) {
      result.failed.push(name);
      result.problem ??= describeError(error);
    }
  }
  return result;
}
