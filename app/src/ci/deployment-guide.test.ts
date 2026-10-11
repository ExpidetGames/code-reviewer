// Keeps docs/deployment-coolify.md, the guide for deploying Code Reviewer on Coolify, in step with the
// files and the code it describes: every variable of .env.example is explained, the table of settings
// agrees with what compose.coolify.yml requires and passes on, the stated defaults are the ones the
// code uses, the sizing table follows the formula, the links resolve, and the root README points to the
// guide. What only a real Coolify instance can show stays manual (CR-39-T02 to T12).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_BACKUP_TIME } from "../backup/config.ts";
import { DEFAULT_BUSY_TIMEOUT_MS } from "../db/config.ts";
import { findDeploymentConfigProblems } from "../deploy/startup.ts";
import { DEFAULT_LLM_MODEL } from "../llm/config.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const guide = read("docs/deployment-coolify.md");
const readme = read("README.md");
const envExample = read(".env.example");
const coolifySource = read("compose.coolify.yml");
const publishWorkflow = read(".github/workflows/publish-images.yml");

type Service = {
  environment?: Record<string, string>;
  mem_limit?: string;
};
type Compose = {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
};
const coolify = parse(coolifySource) as Compose;
const appEnvironment = coolify.services.app?.environment ?? {};

/** The text of the section that starts with the given heading, up to the next heading of that level. */
function section(heading: string): string {
  const start = guide.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`the guide has no "${heading}" section`);
  const rest = guide.slice(start + 1);
  const next = rest.indexOf("\n## ", 3);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every variable named in .env.example, set or only shown in a comment. */
function envExampleVariables(): Set<string> {
  return new Set(
    [
      ...envExample.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm),
      // `# NAME: ...` explains a variable that is not a setting (fixed by the compose files).
      ...envExample.matchAll(/^# ([A-Z][A-Z0-9_]*): \S/gm),
    ].map((match) => match[1] as string),
  );
}

type Row = { names: string[]; required: string; cells: string[] };

/** The rows of the markdown tables in a text whose first cell names variables in backticks. */
function variableRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    const names = [...(cells[0] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map(
      (match) => match[1] as string,
    );
    if (names.length > 0) rows.push({ names, required: cells[1] ?? "", cells });
  }
  return rows;
}

// Settings the guide explains that no .env.example and no Compose file has yet; each one moves into
// them with the ticket that adds it, and the test below then asks for this list to be emptied.
const PLANNED: string[] = [];

const settings = variableRows(section("6. Environment variables"));
const byRequirement = (kind: string): string[] =>
  settings.filter((row) => row.required === kind).flatMap((row) => row.names);

describe("the Coolify guide and the environment variables", () => {
  // CR-39-T03
  it("explains every variable of .env.example", () => {
    const mentioned = new Set(
      [...guide.matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]),
    );

    const missing = [...envExampleVariables()].filter(
      (name) => !mentioned.has(name),
    );

    expect(missing).toEqual([]);
  });

  // CR-39-T03
  it("lists in its table exactly the required settings that compose.coolify.yml requires", () => {
    const required = Object.entries(appEnvironment)
      .filter(([, value]) => String(value).includes(":?"))
      .map(([name]) => name);

    expect(byRequirement("yes").sort()).toEqual(required.sort());
  });

  // CR-39-T03
  it("names the two settings of which one must be set, and both can be set in the Compose file", () => {
    expect(byRequirement("one of two").sort()).toEqual([
      "ALLOWED_GITHUB_LOGINS",
      "ALLOWED_GITHUB_ORG",
    ]);
    for (const name of byRequirement("one of two"))
      expect(appEnvironment[name], name).toBe(`\${${name}:-}`);
  });

  // CR-39-T03
  it("marks as optional exactly the settings the Compose file passes on with a default", () => {
    const withDefault = [
      ...Object.entries(appEnvironment),
      ...Object.entries(coolify.services.runner?.environment ?? {}),
      // The memory limit of the runner is a setting too, though not an environment variable.
      ["RUNNER_MEMORY_LIMIT", String(coolify.services.runner?.mem_limit)],
    ]
      .filter(([, value]) => /^\$\{[A-Z0-9_]+:-/.test(String(value)))
      .map(([name]) => name)
      .filter(
        (name) =>
          !["ALLOWED_GITHUB_LOGINS", "ALLOWED_GITHUB_ORG"].includes(name),
      );

    expect(byRequirement("optional").sort()).toEqual(withDefault.sort());
  });

  // CR-39-T03
  it("says a setting is not used on Coolify only when the Compose file does not pass it on", () => {
    const passedOn = JSON.stringify(coolify);
    for (const name of [
      ...byRequirement("not used"),
      ...byRequirement("planned"),
    ])
      expect(passedOn, name).not.toMatch(new RegExp(`\\b${name}\\b`));
  });

  // CR-39-T03
  it("knows every variable it names: it is in .env.example or on the list of planned settings", () => {
    const known = envExampleVariables();

    const unknown = settings
      .flatMap((row) => row.names)
      .filter((name) => !known.has(name) && !PLANNED.includes(name));

    expect(unknown).toEqual([]);
  });

  it("moves a planned setting into the tables of the settings in use once .env.example has it", () => {
    const known = envExampleVariables();

    expect(PLANNED.filter((name) => known.has(name))).toEqual([]);
  });

  // CR-39-T03
  it("states the defaults and limits the code uses", () => {
    const table = section("6. Environment variables");

    expect(table).toContain(`Empty: \`${DEFAULT_BACKUP_TIME}\``);
    expect(table).toContain(`Empty: ${String(DEFAULT_BUSY_TIMEOUT_MS)}`);
    expect(table).toContain(`Default \`${DEFAULT_LLM_MODEL}\``);
    expect(table).toContain("Empty: 90");
    expect(envExample).toContain("default of 90");
  });

  // CR-39-T03
  it("states the minimum length of the runner token that the app enforces at start", async () => {
    const short = await findDeploymentConfigProblems({
      RUNNER_TOKEN: "x".repeat(31),
    });
    const long = await findDeploymentConfigProblems({
      RUNNER_TOKEN: "x".repeat(32),
    });

    expect(short.some((problem) => problem.includes("RUNNER_TOKEN"))).toBe(
      true,
    );
    expect(long.some((problem) => problem.includes("RUNNER_TOKEN"))).toBe(
      false,
    );
    expect(section("6. Environment variables")).toMatch(
      /`RUNNER_TOKEN`[^\n]*At least 32 characters/,
    );
  });
});

describe("the Coolify guide and the smoke test", () => {
  // CR-51-T01
  it("describes the smoke script without any way to leave out the runner API check", () => {
    const step = section("7. Deploy and check the instance");

    expect(step).toContain("docker/smoke/instance.sh https://<domain>");
    expect(step).toContain("the runner API refuses a request without a token");
    expect(guide).not.toContain("--skip-runner-endpoint");
    expect(guide).not.toContain("Until the runner API is part of the release");
  });

  // CR-51-T01
  it("says what the job loop of the runner does now, and no longer calls it planned or a placeholder", () => {
    expect(guide).not.toMatch(/placeholder/i);
    expect(guide).not.toMatch(/\bplanned\b/i);
    expect(guide).not.toContain("CR-29");
    expect(readme).not.toMatch(/job loop does not exist/i);
    expect(readme).not.toMatch(/placeholder/i);
    expect(section("7. Deploy and check the instance")).toContain(
      "started: 3 slots",
    );
  });

  // CR-39-T03
  it("makes it prominent that one of the two allow list settings must be set", () => {
    const rows = variableRows(section("6. Environment variables")).filter(
      (row) => row.required === "one of two",
    );

    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row.cells.join("|")).toContain("**Set this or");
    expect(section("7. Deploy and check the instance")).toContain(
      "**at least one of `ALLOWED_GITHUB_LOGINS` and `ALLOWED_GITHUB_ORG` is set**",
    );
  });

  it("does not tell people to edit the tracked Compose file to move the backups", () => {
    expect(section("8. Storage and backups")).toContain(
      "Do not edit `compose.coolify.yml` on the tracked branch",
    );
  });
});

describe("the Coolify guide and the Compose file", () => {
  // CR-39-T02
  it("tells where the file is and how the domain is routed to the app", () => {
    expect(guide).toContain("`/compose.coolify.yml`");
    expect(guide).toContain("https://<domain>:3000");
    expect(guide).toContain("/api/webhooks/github-app");
    expect(guide).toMatch(/80[^\n]*443/);
  });

  // CR-39-T05
  it("names every service and every volume of the Compose file", () => {
    for (const name of Object.keys(coolify.services))
      expect(guide, name).toContain(`\`${name}\``);
    for (const name of Object.keys(coolify.volumes ?? {}))
      expect(guide, name).toContain(`\`${name}\``);
  });

  // CR-39-T06
  it("names the images and the tags that the publish workflow pushes to GHCR", () => {
    const published = [
      ...publishWorkflow.matchAll(/^\s+(?:APP|RUNNER)_IMAGE:\s*(\S+)/gm),
    ].map((match) => match[1]);

    expect(published).toHaveLength(2);
    for (const image of published) expect(guide).toContain(image as string);
    for (const tag of ["sha-", "development", "latest"])
      expect(publishWorkflow).toContain(tag);
    expect(guide).toContain("sha-<first 7 characters of the");
    expect(guide).toContain("`development`");
    expect(guide).toContain("`latest`");
    expect(guide).toContain("**private**");
  });

  // CR-39-T06
  it("says why the images are built from the repository", () => {
    const decision = section("2. The decisions in short");

    expect(decision).toContain(
      "Coolify builds both images from the repository",
    );
    expect(decision).toMatch(/Why build from the repository/);
    expect(coolifySource).toContain("build:");
  });
});

describe("the runner in the Coolify guide", () => {
  const runnerSection = section("9. Runner sizing and `RUNNER_CONCURRENCY`");

  // CR-51-T03
  it("explains the settings of the job loop that the Compose file passes on, with the defaults of the code", () => {
    const rows = variableRows(section("6. Environment variables"));
    const row = (name: string) => rows.find((entry) => entry.names[0] === name);

    for (const [name, standard] of [
      ["RUNNER_CONCURRENCY", "3"],
      ["RUNNER_JOB_TIMEOUT_SECONDS", "1200"],
      ["RUNNER_POLL_INTERVAL_SECONDS", "5"],
    ] as const) {
      expect(row(name)?.required, name).toBe("optional");
      expect(row(name)?.cells.join("|"), name).toContain(`Empty: ${standard}`);
      expect(coolify.services.runner?.environment?.[name], name).toBe(
        `\${${name}:-${standard}}`,
      );
    }
  });

  // CR-51-T03
  it("explains the memory limit of the runner, which is what a higher RUNNER_CONCURRENCY needs", () => {
    const rows = variableRows(section("6. Environment variables"));
    const row = rows.find((entry) => entry.names[0] === "RUNNER_MEMORY_LIMIT");

    expect(row?.required).toBe("optional");
    expect(row?.cells.join("|")).toContain("Empty: 2g");
    expect(row?.cells.join("|")).toContain("RUNNER_CONCURRENCY");
    expect(runnerSection).toContain("`RUNNER_MEMORY_LIMIT`");
  });

  // CR-51-T03
  it("names the runner settings the Compose file does not pass on, and why", () => {
    const notUsed = byRequirement("not used");

    expect(notUsed).toContain("RUNNER_SHUTDOWN_GRACE_SECONDS");
    expect(notUsed).toContain("PR_AGENT_COMMAND");
    expect(byRequirement("fixed")).toEqual(["RUNNER_API_URL"]);
    expect(coolify.services.runner?.environment?.RUNNER_API_URL).toBe(
      "http://app:3000",
    );
    expect(guide).toContain("`stop_grace_period: 90s`");
  });

  // CR-51-T04
  it("explains that a stop gives running reviews time to finish and report", () => {
    expect(guide).toContain("`runner_shutdown`");
    expect(guide).toContain("90 seconds");
    // What the smoke test proves, said no stronger than it is: it runs with a shorter grace period.
    expect(guide).toContain(
      "proves that Docker waits for the runner's report instead of killing it after 10 seconds",
    );
    expect(guide).not.toContain("compose.sh` proves this");
  });

  it("tells how to restrict what the runner can reach, naming the three places it needs", () => {
    const hint = runnerSection.slice(
      runnerSection.indexOf("### Restrict what the runner can reach"),
    );

    expect(hint).toContain("### Restrict what the runner can reach");
    for (const place of ["api.github.com", "openrouter.ai", "`app`"])
      expect(hint, place).toContain(place);
    expect(hint).toContain("DOCKER-USER");
  });

  // CR-51-T03
  it("gives one command for the runner token everywhere it is explained", () => {
    // A table row is a unit of its own; everything else is a paragraph (a block of comment lines).
    const units = (text: string): string[] =>
      text
        .split(/\n\s*\n/)
        .flatMap((paragraph) =>
          paragraph.split("\n").every((line) => line.startsWith("|"))
            ? paragraph.split("\n")
            : [paragraph],
        );

    for (const [file, text] of [
      ["the guide", guide],
      ["README.md", readme],
      [".env.example", envExample],
      ["app/.env.example", read("app/.env.example")],
    ] as const) {
      const about = units(text).filter(
        (unit) =>
          unit.includes("RUNNER_TOKEN") && unit.includes("openssl rand"),
      );

      expect(about.length, file).toBeGreaterThan(0);
      for (const unit of about) {
        expect(unit, file).toContain("openssl rand -hex 32");
        expect(unit, file).not.toContain("openssl rand -base64");
      }
    }
  });
});

describe("the backup README", () => {
  const backupReadme = read("app/src/backup/README.md");

  // CR-51 (CR-40 follow-up)
  it("warns about a leftover -wal file next to a restored database and says what SQLite does with it", () => {
    expect(backupReadme).toContain(
      "A leftover `app.db-wal` next to a restored",
    );
    expect(backupReadme).toMatch(/takes the log over/);
    expect(backupReadme).toMatch(/discards the log/);
  });

  // CR-51 (CR-40 follow-up)
  it("does not claim that Coolify has no S3 backups for volumes, and says the use for a Compose volume is not verified", () => {
    expect(backupReadme).not.toContain(
      "cover the databases that Coolify manages",
    );
    expect(backupReadme).toContain("storage-mounts/backups");
    expect(backupReadme).toMatch(/not verified/);
  });
});

describe("the runner sizing in the Coolify guide", () => {
  const sizing = section("9. Runner sizing and `RUNNER_CONCURRENCY`");
  const PEAK_MIB = 321;
  const SAFETY_FACTOR = 1.5;
  const RESERVE_MIB = 256;
  const slots = (mib: number): number =>
    Math.floor((mib - RESERVE_MIB) / (PEAK_MIB * SAFETY_FACTOR));

  // CR-39-T12
  it("gives the number of parallel reviews the formula gives, for every memory size in its table", () => {
    const rows = [
      ...sizing.matchAll(/^\| (\d+) \| `(\d+)g` \| (\d+) \|$/gm),
    ].map(
      (match) =>
        [Number(match[1]), Number(match[2]), Number(match[3])] as const,
    );

    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const [mib, gib, concurrency] of rows) {
      expect(gib * 1024, `${String(mib)} MiB as a Docker limit`).toBe(mib);
      expect(concurrency, `${String(mib)} MiB`).toBe(slots(mib));
    }
  });

  // CR-39-T12
  it("states the formula with the measured numbers", () => {
    expect(sizing).toContain(
      "floor( (runner memory in MiB - 256) / (321 x 1.5) )",
    );
    expect(sizing).toContain("8 GB RAM and 4 vCPU");
  });

  // CR-39-T12
  it("describes the memory limit that the Compose file really sets for the runner", () => {
    const limit = coolify.services.runner?.mem_limit;

    expect(limit).toBe("${RUNNER_MEMORY_LIMIT:-2g}");
    expect(sizing).toContain("`RUNNER_MEMORY_LIMIT`");
    expect(sizing).toContain("**2 GiB** (`2g`, the default of");
    expect(sizing).toContain(`**${String(slots(2048))}** parallel reviews`);
  });
});

describe("the Coolify guide as a document", () => {
  const guideDirectory = resolve(repoRoot, "docs");
  const links = [...guide.matchAll(/\]\(([^)\s]+)\)/g)].map(
    (match) => match[1] as string,
  );

  function anchorsOf(text: string): Set<string> {
    return new Set(
      [...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) =>
        (match[1] as string)
          .toLowerCase()
          .replace(/`/g, "")
          .replace(/[^a-z0-9 _-]/g, "")
          .replace(/ /g, "-"),
      ),
    );
  }

  it("links only to files that exist and to headings that exist", () => {
    const broken: string[] = [];
    const ownAnchors = anchorsOf(guide);
    for (const link of links) {
      if (/^https?:/.test(link)) continue;
      const [file, anchor] = link.split("#") as [string, string | undefined];
      if (file === "") {
        if (anchor && !ownAnchors.has(anchor)) broken.push(link);
        continue;
      }
      const target = resolve(guideDirectory, file);
      if (!existsSync(target)) {
        broken.push(link);
        continue;
      }
      if (anchor && !anchorsOf(readFileSync(target, "utf8")).has(anchor))
        broken.push(link);
    }

    expect(links.length).toBeGreaterThan(10);
    expect(broken).toEqual([]);
  });

  it("links to the other guides it depends on", () => {
    for (const file of [
      "github-app.md",
      "../app/src/backup/README.md",
      "../.env.example",
    ])
      expect(links, file).toContain(file);
    expect(
      existsSync(resolve(guideDirectory, "../docker/smoke/instance.sh")),
    ).toBe(true);
    expect(guide).toContain("docker/smoke/instance.sh https://<domain>");
  });

  // CR-39-T05
  it("covers the first run: sign in, install the GitHub App, activate a project, open a test pull request", () => {
    const checklist = section("12. First-run checklist");

    expect(checklist).toMatch(/\*\*Sign in\.\*\*/);
    expect(checklist).toMatch(/\*\*Install the GitHub App\*\*/);
    expect(checklist).toMatch(/\*\*Activate the repository as a project\.\*\*/);
    expect(checklist).toMatch(/\*\*Open a test pull request\*\*/);
  });

  // CR-39-T05
  it("covers storage, backups off the server, updates, rollback and the single instance", () => {
    expect(section("8. Storage and backups")).toContain(
      "Getting the backups off the server",
    );
    expect(section("8. Storage and backups")).toContain("-wal");
    expect(section("10. One app instance only")).toContain(
      "exactly **one** app container",
    );
    expect(section("11. Updates and rollback")).toContain("**Rollback.**");
    expect(section("11. Updates and rollback")).toContain("**Update.**");
  });

  it("uses no em dash", () => {
    for (const text of [guide, coolifySource, read("docker/smoke/instance.sh")])
      expect(text).not.toContain("—");
  });

  it("is named by the Compose files that belong to it", () => {
    expect(coolifySource).toContain("docs/deployment-coolify.md");
    expect(read("compose.yml")).toContain("docs/deployment-coolify.md");
  });
});

describe("the root README and the Coolify guide", () => {
  // CR-39-T02
  it("links to the deployment guide and to the backup README", () => {
    expect(readme).toContain("](docs/deployment-coolify.md)");
    expect(readme).toContain("](app/src/backup/README.md)");
  });

  it("lists the Coolify Compose file in the repository layout", () => {
    expect(readme).toContain("`compose.coolify.yml`");
  });

  it("no longer leaves the decision on how the server gets the images open", () => {
    expect(readme).not.toContain("is decided with the deployment ticket");
  });
});
