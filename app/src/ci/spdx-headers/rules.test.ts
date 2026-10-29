// SPDX-License-Identifier: LicenseRef-Proprietary

// #118: which files carry the SPDX license header, what it looks like per language, and how it is
// added without disturbing the first line that some files must keep (a shebang, a Dockerfile syntax
// directive). The check over the real files is spdx-headers.test.ts.
import { describe, expect, it } from "vitest";
import {
  addHeader,
  commentStyle,
  findHeader,
  headerProblem,
  isSourceFile,
  MIT_IDENTIFIER,
  requiredIdentifier,
  SPDX_HEADER_TEXT,
} from "./rules.ts";

describe("isSourceFile", () => {
  it.each([
    "app/src/auth/session.ts",
    "app/src/components/button.tsx",
    "app/eslint.config.mjs",
    "app/vitest.config.mts",
    "app/src/app/theme.css",
    "app/src/db/migrations/0001_create_app_meta.ts",
    "runner/src/code_reviewer_runner/cli.py",
    "runner/tests/unit/test_cli.py",
    "docker/smoke/app.sh",
    "fakes/github/server.ts",
    "app/Dockerfile",
    "runner/Dockerfile",
    "Makefile",
  ])("counts %s as a source file", (path) => {
    expect(isSourceFile(path)).toBe(true);
  });

  it.each([
    // Data and configuration, where a comment would change or break the format.
    "app/package.json",
    "app/tsconfig.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "runner/uv.lock",
    "runner/pyproject.toml",
    "compose.yml",
    ".github/workflows/ci.yml",
    "contracts/runner-api.v1.json",
    "app/Dockerfile.dockerignore",
    ".gitignore",
    ".nvmrc",
    ".env.example",
    // Documentation and licenses.
    "README.md",
    "LICENSE",
    "NOTICE",
    // Recorded payloads, spike data and generated or installed files.
    "fakes/fixtures/github-webhooks/ping.json",
    "docs/spike/data/cr-50/fair_runs.py",
    "app/next-env.d.ts",
    "app/node_modules/zod/index.js",
    "runner/.venv/lib/python3.13/site.py",
    "app/.next/server/app.js",
    "runner/src/code_reviewer_runner/__pycache__/cli.py",
  ])("does not count %s as a source file", (path) => {
    expect(isSourceFile(path)).toBe(false);
  });
});

describe("commentStyle", () => {
  it.each([
    ["a.ts", "slashes"],
    ["a.tsx", "slashes"],
    ["a.mts", "slashes"],
    ["a.mjs", "slashes"],
    ["a.js", "slashes"],
    ["a.css", "block"],
    ["a.py", "hash"],
    ["a.sh", "hash"],
    ["app/Dockerfile", "hash"],
    ["Makefile", "hash"],
  ])("uses the %s comment syntax of %s", (path, style) => {
    expect(commentStyle(path)).toBe(style);
  });
});

describe("addHeader", () => {
  it("puts the header on the first line of a TypeScript file, followed by a blank line", () => {
    expect(addHeader("export const a = 1;\n", "slashes")).toBe(
      `// ${SPDX_HEADER_TEXT}\n\nexport const a = 1;\n`,
    );
  });

  it("keeps a file that starts with a comment separate from the header", () => {
    expect(addHeader("// Pins down the thing.\nimport x;\n", "slashes")).toBe(
      `// ${SPDX_HEADER_TEXT}\n\n// Pins down the thing.\nimport x;\n`,
    );
  });

  it("keeps a use client directive working, because a comment may come before it", () => {
    expect(addHeader('"use client";\n\nexport {};\n', "slashes")).toBe(
      `// ${SPDX_HEADER_TEXT}\n\n"use client";\n\nexport {};\n`,
    );
  });

  it("uses a block comment in CSS", () => {
    expect(addHeader("body {}\n", "block")).toBe(
      `/* ${SPDX_HEADER_TEXT} */\n\nbody {}\n`,
    );
  });

  it("uses a hash comment in Python and shell", () => {
    expect(addHeader('"""Doc."""\n', "hash")).toBe(
      `# ${SPDX_HEADER_TEXT}\n\n"""Doc."""\n`,
    );
  });

  it("leaves a shebang on the first line and puts the header below it", () => {
    expect(addHeader("#!/usr/bin/env bash\nset -e\n", "hash")).toBe(
      `#!/usr/bin/env bash\n# ${SPDX_HEADER_TEXT}\n\nset -e\n`,
    );
  });

  it("leaves a Dockerfile syntax directive on the first line, where it has to be", () => {
    expect(
      addHeader("# syntax=docker/dockerfile:1\n#\n# Image.\nFROM x\n", "hash"),
    ).toBe(
      `# syntax=docker/dockerfile:1\n# ${SPDX_HEADER_TEXT}\n#\n# Image.\nFROM x\n`,
    );
  });

  it("keeps a run of Dockerfile parser directives together on top", () => {
    expect(
      addHeader(
        "# syntax=docker/dockerfile:1\n# check=error=true\nFROM x\n",
        "hash",
      ),
    ).toBe(
      `# syntax=docker/dockerfile:1\n# check=error=true\n# ${SPDX_HEADER_TEXT}\n\nFROM x\n`,
    );
  });

  it("does not add a second blank line when the file continues with one", () => {
    expect(addHeader("#!/bin/sh\n\necho hi\n", "hash")).toBe(
      `#!/bin/sh\n# ${SPDX_HEADER_TEXT}\n\necho hi\n`,
    );
  });

  it("handles an empty file", () => {
    expect(addHeader("", "slashes")).toBe(`// ${SPDX_HEADER_TEXT}\n`);
  });

  it("is idempotent: a file with the header comes back unchanged", () => {
    const once = addHeader("export {};\n", "slashes");

    expect(addHeader(once, "slashes")).toBe(once);
  });

  it("keeps Windows line endings", () => {
    expect(addHeader("a\r\nb\r\n", "slashes")).toBe(
      `// ${SPDX_HEADER_TEXT}\r\n\r\na\r\nb\r\n`,
    );
  });
});

describe("findHeader", () => {
  it("finds the identifier near the top of the file", () => {
    expect(
      findHeader("// SPDX-License-Identifier: LicenseRef-Proprietary\n\nx\n"),
    ).toBe("LicenseRef-Proprietary");
    expect(findHeader("#!/bin/sh\n# SPDX-License-Identifier: MIT\n\nx\n")).toBe(
      "MIT",
    );
    expect(
      findHeader("/* SPDX-License-Identifier: LicenseRef-Proprietary */\n"),
    ).toBe("LicenseRef-Proprietary");
  });

  it("finds nothing when the file has no header", () => {
    expect(findHeader("export {};\n")).toBeNull();
  });

  it("does not look further down than the first lines, where a mention in the code would be a false hit", () => {
    expect(
      findHeader(
        "a\nb\nc\nd\n// SPDX-License-Identifier: LicenseRef-Proprietary\n",
      ),
    ).toBeNull();
  });
});

describe("headerProblem", () => {
  it("is null for a file with the required header", () => {
    expect(headerProblem(`// ${SPDX_HEADER_TEXT}\n\nexport {};\n`)).toBeNull();
  });

  it("reports a file without a header as missing", () => {
    expect(headerProblem("export {};\n")).toBe("HEADER_MISSING");
  });

  it("reports a header with another license identifier, because that is not the license of the project", () => {
    expect(
      headerProblem("// SPDX-License-Identifier: MIT\n\nexport {};\n"),
    ).toBe("HEADER_OTHER_LICENSE");
  });
});

describe("the proprietary license (#677)", () => {
  it("names the header LicenseRef-Proprietary", () => {
    expect(SPDX_HEADER_TEXT).toBe(
      "SPDX-License-Identifier: LicenseRef-Proprietary",
    );
  });

  it("rejects the Apache-2.0 header that the project used before, so a stale header cannot come back", () => {
    expect(
      headerProblem("// SPDX-License-Identifier: Apache-2.0\n\nexport {};\n"),
    ).toBe("HEADER_OTHER_LICENSE");
  });
});

describe("the copied shadcn/ui components keep MIT", () => {
  const MIT = `// SPDX-License-Identifier: ${MIT_IDENTIFIER}\n\nexport {};\n`;

  // #166-T03
  it("accepts MIT below app/src/components/ui/ and rejects it elsewhere", () => {
    expect(headerProblem(MIT, "app/src/components/ui/button.tsx")).toBeNull();
    expect(headerProblem(MIT, "app/src/button.tsx")).toBe(
      "HEADER_OTHER_LICENSE",
    );
  });

  // #166-T03
  it("rejects the proprietary header below app/src/components/ui/", () => {
    expect(
      headerProblem(
        `// ${SPDX_HEADER_TEXT}\n\nexport {};\n`,
        "app/src/components/ui/button.tsx",
      ),
    ).toBe("HEADER_OTHER_LICENSE");
  });

  // #166-T03
  it("adds MIT only below app/src/components/ui/ and LicenseRef-Proprietary elsewhere", () => {
    expect(
      addHeader(
        "export {};\n",
        "slashes",
        requiredIdentifier("app/src/components/ui/button.tsx"),
      ),
    ).toBe(MIT);
    expect(
      addHeader(
        "export {};\n",
        "slashes",
        requiredIdentifier("app/src/button.tsx"),
      ),
    ).toBe(`// ${SPDX_HEADER_TEXT}\n\nexport {};\n`);
  });
});
