// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the licensing of the repository (#677): the proprietary, source-visible LICENSE, the
// NOTICE with the attribution that the license of PR-Agent demands, and the license declared in
// every place that carries metadata (package.json, pyproject.toml, both container images). Whether
// the dependencies of the app and the runner are acceptable is decided by license-policy.json and
// enforced by the CI job
// "Licenses: dependency check" (app/src/ci/license-check, which needs the package managers and so
// is not a unit test); THIRD_PARTY_LICENSES.md has to agree with the policy (policy-doc.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

describe("LICENSE", () => {
  const license = read("LICENSE");

  it("is the short proprietary notice of Itegro GmbH, not an open source license", () => {
    expect(license).toMatch(
      /^Copyright \(c\) 2026 Itegro GmbH\. All rights reserved\.\n/,
    );
    expect(license).toContain("proprietary");
    expect(license).toContain("published for transparency only");
    expect(license).not.toMatch(/Apache License|Version 2\.0|MIT License/);
    expect(license.length).toBeLessThan(3000);
  });

  it("grants no license to use, copy, modify, distribute, host, run or self-host", () => {
    const text = license.replace(/\s+/g, " ");

    expect(text).toContain(
      "No license is granted to use, copy, modify, merge, distribute, sublicense, host, run or self-host",
    );
  });

  it("allows only the viewing and forking within GitHub that the GitHub Terms of Service require", () => {
    const text = license.replace(/\s+/g, " ");

    expect(text).toContain("GitHub Terms of Service");
    expect(text).toMatch(/view the code on GitHub/);
    expect(text).toMatch(/fork the repository on GitHub/);
  });

  it("accepts no contributions without a written agreement", () => {
    expect(license.replace(/\s+/g, " ")).toContain(
      "Contributions are not accepted unless Itegro GmbH has agreed to them in writing",
    );
  });

  it("leaves third party components to their own licenses and points to where they are recorded", () => {
    expect(license).toContain("NOTICE");
    expect(license).toContain("THIRD_PARTY_LICENSES.md");
  });

  it("has no placeholder", () => {
    expect(license).not.toMatch(/\[[A-Z ]+\]|TODO|<[a-z ]+>|yyyy/i);
  });
});

describe("NOTICE", () => {
  const notice = read("NOTICE");

  it("names the project and its copyright holder", () => {
    expect(notice).toMatch(/^code-review\.com\n/);
    expect(notice).toContain(
      "Copyright (c) 2026 Itegro GmbH. All rights reserved.",
    );
  });

  it("does not say that the project itself is licensed under Apache or any open source license", () => {
    const own = notice.split("This product includes software developed")[0];

    expect(own).toContain("proprietary");
    expect(own).not.toMatch(/Apache|MIT|licensed under/);
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

// #202: CC-BY asks for the creator, the licence and a link to it, a notice of no warranties, and a
// statement of what was changed. Both data packages are used unmodified.
describe("the Creative Commons attribution", () => {
  const packages = [
    {
      name: "caniuse-lite",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      creator: "Alexis Deveria",
    },
    {
      name: "spdx-exceptions",
      licenseUrl: "https://creativecommons.org/licenses/by/3.0/",
      creator: "The Linux Foundation",
    },
  ] as const;

  function section(text: string, name: string): string {
    const start = text.indexOf(`### Attribution: ${name}`);
    if (start < 0) return "";
    const end = text.indexOf("\n#", start + 1);
    return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
  }

  it.each(packages)(
    "gives $name's creator, licence link, no-warranties notice and unmodified statement in THIRD_PARTY_LICENSES.md",
    ({ name, licenseUrl, creator }) => {
      const entry = section(read("THIRD_PARTY_LICENSES.md"), name);

      expect(entry).toContain(creator);
      expect(entry).toContain(licenseUrl);
      expect(entry).toMatch(/no warranties/i);
      expect(entry).toMatch(/unmodified/i);
    },
  );

  it.each(packages)(
    "names $name and its licence link in NOTICE",
    ({ name, licenseUrl }) => {
      const notice = read("NOTICE").replace(/\s+/g, " ");

      expect(notice).toContain(name);
      expect(notice).toContain(licenseUrl);
      expect(notice).toMatch(/unmodified/i);
    },
  );

  it("ships the same files in the runner package as the repository root holds", () => {
    for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_LICENSES.md"]) {
      expect(read(`runner/src/code_reviewer_runner/licenses/${file}`)).toBe(
        read(file),
      );
    }
  });
});

describe("license metadata", () => {
  it.each(["app", "dispatcher", "tools/vercel"])(
    "declares %s/package.json as UNLICENSED and private",
    (folder) => {
      const manifest = JSON.parse(read(`${folder}/package.json`)) as {
        license?: string;
        private?: boolean;
      };

      expect(manifest.license).toBe("UNLICENSED");
      expect(manifest.private).toBe(true);
    },
  );

  it("declares the runner pyproject.toml as proprietary and refuses an upload to PyPI", () => {
    const pyproject = read("runner/pyproject.toml");

    expect(pyproject).toMatch(/^license = \{ text = "Proprietary" \}$/m);
    expect(pyproject).toContain('"Private :: Do Not Upload"');
    expect(pyproject).not.toMatch(/Apache/);
  });

  it.each(["app", "runner"])("labels the %s image with the license", (part) => {
    const dockerfile = read(`${part}/Dockerfile`).replace(/\\\n/g, " ");

    expect(dockerfile).toMatch(
      /org\.opencontainers\.image\.licenses="LicenseRef-Proprietary"/,
    );
  });

  it("names no Apache license for the project in any package manifest", () => {
    for (const file of [
      "app/package.json",
      "dispatcher/package.json",
      "tools/vercel/package.json",
      "runner/pyproject.toml",
    ])
      expect(read(file), file).not.toMatch(/Apache/);
  });
});
