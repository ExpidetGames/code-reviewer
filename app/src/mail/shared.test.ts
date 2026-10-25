// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that mail is never configured through the environment: no source file of the app reads an
// SMTP variable or the variables of the retired test outbox.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [path]
      : [];
  });
}

describe("the environment", () => {
  // #100-SM-08
  it("is not read for mail by any source file of the app", () => {
    const reading = sourceFiles(SRC).filter((file) =>
      /\b(SMTP_(HOST|PORT|USER|USERNAME|PASSWORD|PASS|FROM|SECURE|URL|SERVER)|MAIL_(HOST|PORT|USER|PASSWORD|FROM)|ALLOW_TEST_MAIL_OUTBOX|TEST_MAIL_OUTBOX_FILE)\b/.test(
        readFileSync(file, "utf8"),
      ),
    );

    expect(reading).toEqual([]);
  });
});
