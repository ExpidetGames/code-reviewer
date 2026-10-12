// SPDX-License-Identifier: Apache-2.0

// Two small file operations shared by the backup and the restore.
//
// No `server-only` import: the command line (cli.ts) runs this code without Next.js.
import { existsSync, linkSync, renameSync, unlinkSync } from "node:fs";
import { errorCode } from "./errors.ts";

// Errors of `link` on a file system that has no hard links (some network and FAT file systems).
const HARD_LINKS_UNSUPPORTED = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
]);

/**
 * Gives the file `from` the name `to` without ever replacing a file: a hard link fails if the name
 * is taken, then the old name is dropped. Where the file system has no hard links, an existence
 * check and a rename do the same job. Returns false (and changes nothing) when `to` exists.
 */
export function renameNoOverwrite(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    unlinkSync(from);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    if (!HARD_LINKS_UNSUPPORTED.has(errorCode(error) ?? "")) throw error;
  }
  if (existsSync(to)) return false;
  renameSync(from, to);
  return true;
}

/** Deletes a file and ignores a failure: used while another error is already on its way. */
export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove; the original error is what matters.
  }
}
