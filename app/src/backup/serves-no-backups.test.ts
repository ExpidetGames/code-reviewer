// SPDX-License-Identifier: Apache-2.0

// Pins down that no HTTP route hands out a backup file. A backup holds sessions and stored tokens,
// so the only way to get one is the server's volume. The checks are on the code of the routes and on
// the access rule, because a route that is not there cannot be called by mistake or by an attacker.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideAccess, isPublicPath } from "../auth/access.ts";

const appDir = fileURLToPath(new URL("../app/", import.meta.url));

function routeFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /^route\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("serving backups over HTTP", () => {
  // CR-40-T12
  it("has a route that reads the backup code only for the status, and none that streams files", () => {
    const usingBackups = routeFiles(appDir).filter((file) =>
      /@\/backup|\.\.\/backup/.test(readFileSync(file, "utf8")),
    );

    expect(usingBackups.map((file) => file.slice(appDir.length))).toEqual([
      join("api", "backup", "status", "route.ts"),
    ]);
    const status = readFileSync(usingBackups[0] ?? "", "utf8");
    expect(status).not.toMatch(/createReadStream|readFile|sendFile|BACKUP_DIR/);
  });

  // CR-40-T12
  it("keeps the status route behind the sign in, like every route that is not listed as public", () => {
    expect(isPublicPath("/api/backup/status")).toBe(false);
    expect(
      decideAccess({ pathname: "/api/backup/status", authenticated: false }),
    ).toEqual({ kind: "unauthorized" });
  });
});
