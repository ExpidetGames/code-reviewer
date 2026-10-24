// SPDX-License-Identifier: LicenseRef-Proprietary

// The two questions the snapshot decision asks git (#403). A commit is passed as a 40 character hex string and
// nothing else, so it can never be read as an option.
import { execFile } from "node:child_process";

const COMMIT = /^[0-9a-f]{40}$/;

function git(directory: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd: directory, windowsHide: true },
      (error) => {
        if (error === null) return resolve(0);
        const code = (error as { code?: unknown }).code;
        if (typeof code === "number") return resolve(code);
        reject(new Error("git_unavailable"));
      },
    );
  });
}

/** Whether the commit is an object of the clone. */
export async function commitKnown(
  directory: string,
  commit: string,
): Promise<boolean> {
  if (!COMMIT.test(commit)) return false;
  return (await git(directory, ["cat-file", "-e", `${commit}^{commit}`])) === 0;
}

/** Whether any of the paths (from the top of the repository, wherever the command runs) differs between the two commits. Throws when it cannot tell (a missing commit, no git). */
export async function pathsChanged(
  directory: string,
  from: string,
  to: string,
  paths: readonly string[],
): Promise<boolean> {
  if (!COMMIT.test(from) || !COMMIT.test(to)) throw new Error("commit_invalid");
  const status = await git(directory, [
    "diff",
    "--quiet",
    "--no-renames",
    from,
    to,
    "--",
    ...paths.map((path) => `:(top)${path}`),
  ]);
  if (status === 0) return false;
  if (status === 1) return true;
  throw new Error("git_diff_failed");
}
