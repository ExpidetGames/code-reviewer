// Pins down the licensing of the repository: the Apache-2.0 text, the NOTICE with the attribution
// that the license of PR-Agent demands, and the license declared in every place that carries
// metadata (package.json, pyproject.toml, both container images). Whether the dependencies of the
// app and the runner fit Apache-2.0 is recorded in THIRD_PARTY_LICENSES.md; it is checked by hand
// when dependencies change, because a scan needs the package managers and so is not a unit test.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

describe("LICENSE", () => {
  it("is the unmodified Apache License, Version 2.0", () => {
    const license = read("LICENSE");

    expect(license).toContain(
      "Apache License\n                           Version 2.0, January 2004",
    );
    expect(license).toContain(
      "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
    );
    expect(license).toContain("END OF TERMS AND CONDITIONS");
    expect(createHash("sha256").update(license).digest("hex")).toBe(
      "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    );
  });
});

describe("NOTICE", () => {
  const notice = read("NOTICE");

  it("names the project and its copyright holder", () => {
    expect(notice).toMatch(/^code-review\.com\n/);
    expect(notice).toContain(
      "Copyright 2026 Itegro GmbH and the code-review.com contributors",
    );
  });

  it("points to the third party licenses file", () => {
    expect(notice).toContain("THIRD_PARTY_LICENSES.md");
  });
});

describe("THIRD_PARTY_LICENSES.md", () => {
  const licenses = read("THIRD_PARTY_LICENSES.md");

  it("preserves the complete MIT license text of PR-Agent as one block", () => {
    const mit = [
      "MIT License",
      "",
      "Copyright (c) 2026 The PR Agent",
      "",
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
      'of this software and associated documentation files (the "Software"), to deal',
      "in the Software without restriction, including without limitation the rights",
      "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
      "copies of the Software, and to permit persons to whom the Software is",
      "furnished to do so, subject to the following conditions:",
      "",
      "The above copyright notice and this permission notice shall be included in all",
      "copies or substantial portions of the Software.",
      "",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
      "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
      "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
      "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
      "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
      "SOFTWARE.",
    ].join("\n");

    expect(licenses).toContain(mit);
  });

  it("states the pinned PR-Agent version that the notice belongs to", () => {
    const pinned = /"pr-agent==([0-9.]+)"/.exec(read("runner/pyproject.toml"));

    expect(pinned).not.toBeNull();
    expect(licenses).toContain(`pr-agent ${pinned?.[1]}`);
  });

  it("names the html2text version that the runner lockfile pins", () => {
    const locked = /name = "html2text"\nversion = "([0-9.]+)"/.exec(
      read("runner/uv.lock"),
    );

    expect(locked).not.toBeNull();
    expect(licenses).toContain(`\`html2text\` ${locked?.[1]}`);
    expect(licenses).toContain(`html2text-${locked?.[1]}.dist-info`);
  });
});

describe("license metadata", () => {
  it("declares Apache-2.0 in the app package.json", () => {
    const manifest = JSON.parse(read("app/package.json")) as {
      license?: string;
    };

    expect(manifest.license).toBe("Apache-2.0");
  });

  it("declares Apache-2.0 in the runner pyproject.toml", () => {
    expect(read("runner/pyproject.toml")).toMatch(/^license = "Apache-2\.0"$/m);
  });

  it.each(["app", "runner"])("labels the %s image with the license", (part) => {
    const dockerfile = read(`${part}/Dockerfile`).replace(/\\\n/g, " ");

    expect(dockerfile).toMatch(
      /org\.opencontainers\.image\.licenses="Apache-2\.0"/,
    );
  });
});
