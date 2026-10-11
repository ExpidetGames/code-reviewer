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
    expect(notice).toMatch(/Copyright 20\d{2} .+/);
  });

  it("points to the third party licenses file", () => {
    expect(notice).toContain("THIRD_PARTY_LICENSES.md");
  });
});

describe("THIRD_PARTY_LICENSES.md", () => {
  const licenses = read("THIRD_PARTY_LICENSES.md");

  it("preserves the MIT permission text and copyright notice of PR-Agent", () => {
    expect(licenses).toContain("PR-Agent");
    expect(licenses).toContain("Copyright (c) 2026 The PR Agent");
    expect(licenses).toContain(
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    );
    expect(licenses).toContain(
      "The above copyright notice and this permission notice shall be included in all",
    );
  });

  it("states the pinned PR-Agent version that the notice belongs to", () => {
    const pinned = /"pr-agent==([0-9.]+)"/.exec(read("runner/pyproject.toml"));

    expect(pinned).not.toBeNull();
    expect(licenses).toContain(`pr-agent ${pinned?.[1]}`);
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
