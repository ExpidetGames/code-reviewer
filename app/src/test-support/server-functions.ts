// SPDX-License-Identifier: LicenseRef-Proprietary

// Whether a source file is a file of Server Functions: its first lines hold the `"use server"` directive.
export function isServerFunctionFile(source: string): boolean {
  return /^\s*(["'])use server\1/m.test(
    source.split("\n").slice(0, 5).join("\n"),
  );
}
