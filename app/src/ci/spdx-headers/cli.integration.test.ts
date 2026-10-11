// SPDX-License-Identifier: Apache-2.0

// #118: the command that writes and checks the headers, against a throwaway git repository.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.ts";

const directories: string[] = [];

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "spdx-"));
  directories.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function run(args: string[], root: string) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = runCli(args, root, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { exitCode, out, err };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const HEADER = "SPDX-License-Identifier: Apache-2.0";

describe("spdx-headers cli", () => {
  // #118-T04
  it("--check fails and names every source file without the header", () => {
    const root = repository({
      "a.ts": "export {};\n",
      "src/b.py": `# ${HEADER}\n\nx = 1\n`,
      "data.json": "{}\n",
    });

    const result = run(["--check"], root);

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("missing SPDX header: a.ts");
    expect(result.err.join("\n")).not.toContain("b.py");
    expect(result.err.join("\n")).not.toContain("data.json");
  });

  // #118-T04
  it("--write adds the header to those files only, and --check then passes", () => {
    const root = repository({
      "a.ts": "export {};\n",
      "run.sh": "#!/usr/bin/env bash\nset -e\n",
      "data.json": "{}\n",
    });

    const written = run(["--write"], root);

    expect(written.exitCode).toBe(0);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(
      `// ${HEADER}\n\nexport {};\n`,
    );
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe(
      `#!/usr/bin/env bash\n# ${HEADER}\n\nset -e\n`,
    );
    expect(readFileSync(join(root, "data.json"), "utf8")).toBe("{}\n");
    expect(run(["--check"], root).exitCode).toBe(0);
  });

  it("--write run twice changes nothing the second time", () => {
    const root = repository({ "a.ts": "export {};\n" });
    run(["--write"], root);
    const once = readFileSync(join(root, "a.ts"), "utf8");

    const second = run(["--write"], root);

    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(once);
    expect(second.out).toEqual(["Added the header to 0 file(s)."]);
  });

  it("rejects anything but exactly one known option", () => {
    const root = repository({});

    expect(run([], root).exitCode).toBe(2);
    expect(run(["--fix"], root).exitCode).toBe(2);
    expect(run(["--check", "--write"], root).exitCode).toBe(2);
  });
});
