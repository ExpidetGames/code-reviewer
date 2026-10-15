// SPDX-License-Identifier: Apache-2.0

// Keeps the deployment guide (docs/deployment-vercel.md) and dispatcher/.env.example in step with what the
// Dispatcher reads (#333): every variable the code reads is a placeholder in .env.example and a row of the
// guide's Dispatcher table, the table names no variable the code does not read, the stated defaults and limits are
// the code's, and the commands and names the guide gives for the snapshot and the canary exist.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "./config.ts";
import { VM_TIMEOUT_MARGIN_SECONDS } from "./launchers/sandbox.ts";

const ROOT = join(import.meta.dirname, "..");
const REPO = join(ROOT, "..");

function read(path: string): string {
  return readFileSync(join(REPO, path), "utf8");
}

const guide = read("docs/deployment-vercel.md");
const envExample = read("dispatcher/.env.example");

/** The text of a section from its heading to the next heading of the same or a higher level. */
function section(heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const start = guide.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`the guide has no "${heading}" section`);
  const rest = guide.slice(start + 1);
  const next = new RegExp(`\\n#{1,${String(level)}} `).exec(
    rest.slice(heading.length),
  );
  return next === null ? rest : rest.slice(0, heading.length + next.index);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory())
      return ["contracts", "test-support", "fixtures", "testdata"].includes(
        entry,
      )
        ? []
        : sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every variable the Dispatcher's source reads from its environment, the deploy canary and the snapshot command too. */
function variablesRead(): Set<string> {
  const names = new Set<string>();
  const add = (source: string, pattern: RegExp): void => {
    for (const match of source.matchAll(pattern))
      for (const name of match.slice(1)) if (name) names.add(name);
  };
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const source = readFileSync(file, "utf8");
    add(source, /\b(?:read|required|integer)\(\s*env,\s*"([A-Z][A-Z0-9_]+)"/g);
    add(source, /\bkey\(\s*env,\s*"([A-Z][A-Z0-9_]+)",\s*"([A-Z][A-Z0-9_]+)"/g);
    add(source, /\benv\.([A-Z][A-Z0-9_]+)/g);
    add(source, /\bdeps\.env\.([A-Z][A-Z0-9_]+)/g);
    add(source, /\bmissing: "([A-Z][A-Z0-9_]+)"/g);
  }
  return names;
}

/** Every variable named in .env.example, set, shown in a comment, or noted as `# NAME: ...`. */
function documented(): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of envExample.split("\n")) {
    const assignment = /^#?\s?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (assignment) result.set(assignment[1] ?? "", assignment[2] ?? "");
    const note = /^# ([A-Z][A-Z0-9_]*): \S/.exec(line);
    if (note) result.set(note[1] ?? "", "");
  }
  return result;
}

const SECRET_NAME = /SECRET|TOKEN/;

describe("dispatcher/.env.example", () => {
  // #333-T02
  it("lists every variable the Dispatcher reads, as a placeholder", () => {
    const present = documented();

    const missing = [...variablesRead()].filter((name) => !present.has(name));

    expect(variablesRead().size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  // #333-T02
  it("lists no variable the Dispatcher does not read", () => {
    const read = variablesRead();

    expect([...documented().keys()].filter((name) => !read.has(name))).toEqual(
      [],
    );
  });

  // #333-T02, #333-T03
  it("holds no value for a secret and no real host, token or id", () => {
    for (const [name, value] of documented()) {
      if (SECRET_NAME.test(name)) expect(value, name).toBe("");
      expect(value, name).not.toMatch(
        /ghp_|github_pat_|sk-|snap_[A-Za-z0-9]|prj_|team_[A-Za-z0-9]/,
      );
    }
    expect(documented().get("SANDBOX_SNAPSHOT_ID")).toBe("");
    expect(documented().get("SANDBOX_IMAGE_DIGEST")).toBe("");
    expect(envExample).not.toMatch(/sha256:[0-9a-f]{64}/);
  });

  // #333-T02
  it("is the example for the Dispatcher's configuration: the required variables are not commented out", () => {
    const required = [
      "RUNNER_API_URL",
      "RUNNER_TOKEN",
      "DISPATCHER_MAX_RUNNING",
      "DISPATCHER_SIGNING_KEY_ID",
      "DISPATCHER_SIGNING_SECRET",
    ];
    for (const name of required)
      expect(envExample, name).toMatch(new RegExp(`^${name}=`, "m"));
    // The example values themselves load once the secrets are filled in.
    const loaded = loadSettings({
      RUNNER_API_URL: "https://reviews.example.com",
      RUNNER_TOKEN: "t".repeat(40),
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: "k1",
      DISPATCHER_SIGNING_SECRET: "s".repeat(40),
    });
    expect(loaded.core.maxRunning).toBe(2);
  });
});

describe("the Dispatcher section of the guide", () => {
  const table = section("### 3.2 The Dispatcher project");

  function namesIn(text: string): string[] {
    return [...text.matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map(
      (match) => match[1] as string,
    );
  }

  /** The first cell of a row may name several variables (`A`, `B`). */
  function rowNames(text: string): string[] {
    return text
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .flatMap((line) =>
        [...(line.split("|")[1] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map(
          (match) => match[1] as string,
        ),
      );
  }

  // #333-T02
  it("explains every variable the deployed Dispatcher reads", () => {
    const deployed = [...variablesRead()].filter(
      (name) =>
        ![
          "CANARY_ALLOWED_HOSTS",
          "VERCEL_AUTOMATION_BYPASS_SECRET",
          "PORT",
          "DISPATCHER_SHUTDOWN_GRACE_SECONDS",
          "VERCEL_OIDC_TOKEN",
        ].includes(name),
    );
    const named = new Set(
      [...table.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]),
    );

    const missing = deployed.filter((name) => !named.has(name));

    expect(missing).toEqual([]);
  });

  // #333-T04
  it("names no variable the code does not read", () => {
    const read = variablesRead();

    const unknown = rowNames(table).filter((name) => !read.has(name));

    expect(namesIn(table).length).toBeGreaterThan(10);
    expect(unknown).toEqual([]);
  });

  // #333-T04
  it("states the defaults and ranges of the code", () => {
    const { core } = loadSettings({
      RUNNER_API_URL: "https://reviews.example.com",
      RUNNER_TOKEN: "t".repeat(40),
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: "k1",
      DISPATCHER_SIGNING_SECRET: "s".repeat(40),
    });

    expect(table).toMatch(
      new RegExp(
        `DISPATCHER_JOB_TIMEOUT_SECONDS\`[^\\n]*default \\*\\*${String(core.jobTimeoutSeconds)}\\*\\*`,
      ),
    );
    expect(table).toMatch(
      new RegExp(
        `SANDBOX_VM_TIMEOUT_MARGIN_SECONDS\`[^\\n]*default ${String(VM_TIMEOUT_MARGIN_SECONDS)}\\.`,
      ),
    );
    expect(core.launchDeadlineSeconds).toBe(300);
    expect(table).toContain("at most 300 s");
    expect(core.poolId).toBe("dispatcher");
    expect(table).toMatch(/DISPATCHER_POOL_ID`[^\n]*Default `dispatcher`/);
    expect(core.engines).toEqual(["pr-agent", "opencode"]);
  });

  // #333-T04
  it("says what an unset snapshot does and that the snapshot and the digest go together", () => {
    expect(table).toMatch(
      /SANDBOX_SNAPSHOT_ID`[^\n]*Unset, the Dispatcher has no Launcher and claims nothing/,
    );
    expect(table).toMatch(
      /SANDBOX_IMAGE_DIGEST`[^\n]*change the two together/i,
    );
  });

  // #333-T04
  it("tells that the cap of the Dispatcher and the App's cap must be the same number", () => {
    expect(table).toMatch(
      /DISPATCHER_MAX_RUNNING`[^\n]*equal the App's `RUNNER_DISPATCH_MAX_RUNNING`/,
    );
    expect(section("### 3.1 The App project")).toMatch(
      /RUNNER_DISPATCH_MAX_RUNNING`[^\n]*equal the Dispatcher's `DISPATCHER_MAX_RUNNING`/,
    );
  });
});

describe("the commands and names the guide gives", () => {
  const dispatcherPackage = JSON.parse(read("dispatcher/package.json")) as {
    scripts: Record<string, string>;
  };
  const appPackage = JSON.parse(read("app/package.json")) as {
    scripts: Record<string, string>;
  };
  const snapshotWorkflow = read(".github/workflows/golden-snapshot.yml");
  const canaryWorkflow = read(".github/workflows/dispatcher-canary.yml");

  // #333-T04
  it("uses scripts that exist", () => {
    expect(guide).toContain("pnpm --dir app migrate");
    expect(guide).toContain("pnpm --dir app setup-code");
    expect(appPackage.scripts).toHaveProperty("migrate");
    expect(appPackage.scripts).toHaveProperty("setup-code");
    expect(dispatcherPackage.scripts).toHaveProperty("snapshot:build");
    expect(dispatcherPackage.scripts).toHaveProperty("probe:canary");
  });

  // #333-T04
  it("names the workflows, environments, secrets, inputs and variables as they are", () => {
    for (const name of ["hosted-snapshot", "hosted-canary"]) {
      expect(guide).toContain(name);
    }
    expect(snapshotWorkflow).toContain("environment: hosted-snapshot");
    expect(canaryWorkflow).toContain("environment: hosted-canary");
    for (const secret of [
      "VERCEL_TOKEN",
      "VERCEL_TEAM_ID",
      "VERCEL_PROJECT_ID",
    ]) {
      expect(snapshotWorkflow).toContain(`secrets.${secret}`);
      expect(guide).toContain(secret);
    }
    expect(canaryWorkflow).toContain("secrets.RUNNER_TOKEN");
    expect(canaryWorkflow).toContain("secrets.VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(canaryWorkflow).toContain("vars.DISPATCHER_CANARY_HOSTS");
    expect(snapshotWorkflow).toContain("vars.GOLDEN_SNAPSHOT_ENABLED");
    for (const input of ["pinned_snapshot", "target"]) {
      expect(snapshotWorkflow).toContain(`${input}:`);
      expect(guide).toContain(`\`${input}\``);
    }
    for (const input of ["url", "engines"]) {
      expect(canaryWorkflow).toContain(`${input}:`);
      expect(guide).toContain(`\`${input}\``);
    }
    expect(guide).toContain("DISPATCHER_CANARY_HOSTS");
    expect(guide).toContain("GOLDEN_SNAPSHOT_ENABLED");
    expect(guide).toContain("golden-snapshot-record");
  });

  // #333-T04
  it("states the function limit and the region of dispatcher/vercel.json", () => {
    const config = JSON.parse(read("dispatcher/vercel.json")) as {
      regions: string[];
      functions: Record<string, { maxDuration: number }>;
    };

    expect(config.regions).toEqual(["fra1"]);
    expect(guide).toContain("`fra1`");
    expect(guide).toContain(
      `\`maxDuration\` of **${String(config.functions["src/index.ts"]?.maxDuration)} seconds**`,
    );
  });
});
