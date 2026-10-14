// SPDX-License-Identifier: Apache-2.0

// #118: THIRD_PARTY_LICENSES.md and license-policy.json say the same. The policy is what the CI
// scan enforces; the document is what readers (and the attribution duties) rely on. Both are
// edited by hand, so this test fails when one of them moves without the other.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePolicy, type Ecosystem } from "./policy.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const policy = parsePolicy(JSON.parse(read("license-policy.json")));
const document = read("THIRD_PARTY_LICENSES.md");

type Row = {
  ecosystem: Ecosystem;
  kind: "exception" | "notInstalled";
  package: string;
  license: string;
};

const backticked = (text: string): string[] =>
  [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");

/** The text between the heading that starts with `title` and the next heading of the same or a higher level. */
function section(title: string): string {
  const lines = document.split("\n");
  const start = lines.findIndex((line) => line.startsWith(title));
  if (start === -1) throw new Error(`no section "${title}"`);
  const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 0;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#+) /.exec(line);
    if (heading && (heading[1]?.length ?? 0) <= level) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Every table row below "### App" and "### Runner", with the ecosystem and kind its headings give. */
function documentedRows(): Row[] {
  const rows: Row[] = [];
  let ecosystem: Ecosystem | null = null;
  let kind: Row["kind"] | null = null;
  for (const line of document.split("\n")) {
    if (line.startsWith("### ")) {
      ecosystem = line.startsWith("### App")
        ? "npm"
        : line.startsWith("### Runner")
          ? "python"
          : line.startsWith("### Bundled binaries")
            ? "bun"
            : null;
      kind = null;
    } else if (line.startsWith("#### ")) {
      kind = line.startsWith("#### Exceptions")
        ? "exception"
        : line.startsWith("#### Not installed")
          ? "notInstalled"
          : null;
    } else if (line.startsWith("|") && ecosystem && kind) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const first = cells[0] ?? "";
      if (first === "Package" || /^-+$/.test(first)) continue;
      for (const name of backticked(first)) {
        rows.push({ ecosystem, kind, package: name, license: cells[1] ?? "" });
      }
    }
  }
  return rows;
}

const key = (row: Row): string =>
  `${row.ecosystem} ${row.kind} ${row.package} ${row.license}`;

describe("THIRD_PARTY_LICENSES.md and license-policy.json", () => {
  it("list the same allowed licenses", () => {
    const firstParagraph =
      section("### Allowed licenses").trim().split("\n\n")[0] ?? "";

    expect(backticked(firstParagraph).sort()).toEqual(
      [...policy.allowed].sort(),
    );
  });

  it("list the same exceptions, with the same licenses", () => {
    const documented = documentedRows()
      .filter((row) => row.kind === "exception")
      .map(key)
      .sort();
    const configured = policy.exceptions
      .map((entry) =>
        key({
          ecosystem: entry.ecosystem,
          kind: "exception",
          package: entry.package,
          license: entry.licenses.join(", "),
        }),
      )
      .sort();

    expect(documented).toEqual(configured);
  });

  it("list the same packages that are not installed on every platform, with the same licenses", () => {
    const documented = documentedRows()
      .filter((row) => row.kind === "notInstalled")
      .map(key)
      .sort();
    const configured = policy.notInstalled
      .map((entry) =>
        key({
          ecosystem: entry.ecosystem,
          kind: "notInstalled",
          package: entry.package,
          license: entry.license,
        }),
      )
      .sort();

    expect(documented).toEqual(configured);
  });

  it("document at least the tables that the checks above compare", () => {
    expect(documentedRows().length).toBeGreaterThan(10);
  });

  // #202-T06
  describe("prebuilt binaries", () => {
    /** The rows of the "#### Binaries" table: name, version, license, source commit (or "-"). */
    function documentedBinaries(): string[] {
      const rows: string[] = [];
      let inTable = false;
      for (const line of section("### Bundled binaries").split("\n")) {
        if (line.startsWith("#### "))
          inTable = line.startsWith("#### Binaries");
        else if (inTable && line.startsWith("|")) {
          const cells = line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim());
          const first = cells[0] ?? "";
          if (first === "Binary" || /^-+$/.test(first)) continue;
          rows.push(
            [first, cells[1], cells[2], cells[3]]
              .map((cell) => (cell ?? "").replaceAll("`", ""))
              .join(" "),
          );
        }
      }
      return rows.sort();
    }

    it("lists the same binaries, versions, licenses and source commits as the policy", () => {
      const configured = policy.binaries
        .map((entry) =>
          [entry.name, entry.version, entry.license, entry.commit ?? "-"].join(
            " ",
          ),
        )
        .sort();

      expect(documentedBinaries()).toEqual(configured);
    });

    it("keeps the copyright line and the permission text of OpenCode and ripgrep", () => {
      expect(document).toContain("Copyright (c) 2025 opencode");
      expect(document).toContain("Copyright (c) 2015 Andrew Gallant");
      expect(document).toContain("The Unlicense");
      expect(
        document.match(/Permission is hereby granted, free of charge/g)?.length,
      ).toBeGreaterThanOrEqual(4);
    });

    it("states what the bundled-dependency snapshot is and what its caveat is", () => {
      const bundled = policy.binaries.find((entry) => entry.bundledLicenses);

      expect(bundled?.bundledLicenses).toBe(
        "runner/opencode-bundled-licenses.json",
      );
      expect(document).toContain("runner/opencode-bundled-licenses.json");
      expect(document).toContain("upper bound");
      expect(document).toContain("runner/scripts/audit_opencode_bundle.py");
    });

    it("names OpenCode and ripgrep, with version and source commit, in NOTICE", () => {
      const notice = read("NOTICE");

      for (const entry of policy.binaries) {
        expect(notice.toLowerCase(), entry.name).toContain(entry.name);
        expect(notice, entry.name).toContain(entry.version);
        if (entry.commit) expect(notice, entry.name).toContain(entry.commit);
      }
    });
  });
});
