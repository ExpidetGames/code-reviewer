// SPDX-License-Identifier: Apache-2.0

// Keeps docs/deployment-vercel.md (the guide for the hosted deployment on Vercel) and docs/dispatcher.md in step
// with the files and the code they describe (#333). The App table of the guide is checked against the CODE, not only
// against .env.example: every variable the hosted-relevant source files read has a row (the first cell names it) or is on the
// guide's list of variables that are not set; the Required and Secret columns are what the code does when it is run
// without the variable; ranges and defaults come from the code's own constants; the crons and durations are those of the
// vercel.json files; each step of the first deployment contains what belongs to it; the error codes exist; the links
// resolve; the README and the other deployment guides link to the guide; and none of the public files holds an account
// id, a snapshot id, a digest, a secret shape, a price, a company name or a real host name. What only a real deployment
// can show is listed in the guide's section 9 and stays manual.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "../auth/config.ts";
import { refuseUnlessCron } from "../cron/auth.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import {
  SERVERLESS_DEFAULT_POOL_MAX,
  SERVERLESS_MAX_POOL_MAX,
  loadDatabaseConfig,
} from "../db/config.ts";
import { findDeploymentConfigProblems } from "../deploy/startup.ts";
import {
  MIN_DISPATCH_SECRET_LENGTH,
  OTHER_CREDENTIAL_VARIABLES,
  dispatchConfigProblems,
} from "../dispatch/config.ts";
import {
  DEFAULT_GIVE_UP_SECONDS,
  GIVE_UP_SECONDS_RANGE,
  MAX_RUNNING_RANGE,
  loadSweepSettings,
} from "../dispatch/sweep-settings.ts";
import { LLM_DEFAULT_VARIABLES } from "../llm/config.ts";
import { operatorTokenProblem } from "../operator-api/token.ts";
import { ERROR_COPY } from "../runs/error-copy.ts";
import { resolveRuntimeMode } from "../runtime/mode.ts";
import { SETUP_CODE_TTL_MS } from "../setup/code-store.ts";
import { configuredDebounceMs } from "../webhooks/debounce-config.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const guide = read("docs/deployment-vercel.md");
const dispatcherDoc = read("docs/dispatcher.md");
const envExample = read(".env.example");
const readme = read("README.md");

/**
 * The text of the section with the given heading, up to the next heading of the same or a higher level. Lines inside a
 * code fence are never headings (a shell comment starts with `# `).
 */
function section(heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const lines = guide.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) throw new Error(`the guide has no "${heading}" section`);
  let inFence = false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,6}) /.exec(line);
    if (match && (match[1] as string).length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every variable named in .env.example, set or only shown in a comment. */
function envExampleVariables(): Set<string> {
  return new Set(
    [
      ...envExample.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm),
      ...envExample.matchAll(/^# ([A-Z][A-Z0-9_]*): \S/gm),
    ].map((match) => match[1] as string),
  );
}

type Row = { names: string[]; required: string; secret: string; text: string };

/** The rows of a table of the guide: the names in the FIRST cell, then Required, Secret and the text. */
function rowsOf(text: string): Row[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .slice(1, line.endsWith("|") ? -1 : undefined)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim());
      return {
        names: [...(cells[0] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map(
          (match) => match[1] as string,
        ),
        required: cells[1] ?? "",
        secret: cells[2] ?? "",
        text: cells.slice(3).join(" | "),
      };
    });
}

/** Line breaks and runs of white space as one space, so a sentence can be wrapped anywhere in the guide. */
const flat = (text: string): string => text.replace(/\s+/g, " ");

const GOOD_TOKEN = "r".repeat(40);
const WEBHOOK = {
  RUNNER_TOKEN: GOOD_TOKEN,
  RUNNER_DISPATCH: "webhook",
  RUNNER_WEBHOOK_URL: "https://dispatcher.example.com/dispatch",
  RUNNER_WEBHOOK_SECRET: "w".repeat(40),
};

describe("the App section of the guide against the code", () => {
  const appSection = section("### 3.1 The App project");
  const appTable = appSection.split(
    "Not set in the project, on purpose:",
  )[0] as string;
  const rows = rowsOf(appTable);
  const row = (name: string): Row => {
    const found = rows.find((candidate) => candidate.names.includes(name));
    if (!found) throw new Error(`no row for ${name} in the App table`);
    return found;
  };
  const named = rows.flatMap((candidate) => candidate.names);
  const notSet = appSection.split(
    "Not set in the project, on purpose:",
  )[1] as string;

  /** Every variable the files that decide the hosted App's behavior read, and the code's own lists of them. */
  function variablesOfTheCode(): Set<string> {
    const files = [
      "app/src/dispatch/config.ts",
      "app/src/dispatch/sweep-settings.ts",
      "app/src/cron/auth.ts",
      "app/src/runtime/mode.ts",
      "app/src/db/config.ts",
      "app/src/llm/config.ts",
      "app/src/operator-api/token.ts",
      "app/src/runner-api/token-auth.ts",
      "app/src/webhooks/debounce-config.ts",
      "app/src/auth/config.ts",
      "app/src/crypto/app-secret.ts",
      "app/src/deploy/startup.ts",
    ];
    const names = new Set<string>();
    for (const file of files) {
      const source = read(file);
      for (const match of source.matchAll(
        /\benv\.([A-Z][A-Z0-9_]+)|\(\s*env,\s*"([A-Z][A-Z0-9_]+)"|\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]|\brequired\(\s*env,\s*"([A-Z][A-Z0-9_]+)"/g,
      ))
        for (const name of match.slice(1)) if (name) names.add(name);
    }
    for (const name of [
      ...LLM_DEFAULT_VARIABLES,
      ...OTHER_CREDENTIAL_VARIABLES,
    ])
      names.add(name);
    names.add("APP_SECRET");
    names.add("BETTER_AUTH_URL");
    return names;
  }

  /** A name is "not set" when the guide's list says so, by name or by a prefix like `GITHUB_*`. */
  function onTheNotSetList(name: string): boolean {
    const heads = notSet
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).split(":")[0] as string);
    return [...heads.join(" ").matchAll(/`([A-Z][A-Z0-9_]*\*?)`/g)].some(
      (match) => {
        const entry = match[1] as string;
        return entry.endsWith("*")
          ? name.startsWith(entry.slice(0, -1))
          : name === entry;
      },
    );
  }

  // #333-T02, #333-T04
  it("has a row for every variable the code reads, or says it is not set", () => {
    const missing = [...variablesOfTheCode()].filter(
      (name) => !named.includes(name) && !onTheNotSetList(name),
    );

    expect(variablesOfTheCode().size).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  // #333-T02
  it("is covered by .env.example, which holds a placeholder for every variable of a row", () => {
    const known = envExampleVariables();

    expect(named.filter((name) => !known.has(name))).toEqual([]);
    expect(rows.length).toBeGreaterThan(15);
  });

  // #333-T04
  it("does not give a row to a variable that the guide says is not set", () => {
    expect(named.filter((name) => onTheNotSetList(name))).toEqual([]);
  });

  // #333-T04
  it("says Required where the code refuses to start or to serve without the variable", () => {
    const base = {
      APP_SECRET: "m".repeat(40),
      BETTER_AUTH_URL: "https://reviews.example.com",
      APP_RUNTIME: "serverless",
      DATABASE_URL: "postgres://app:pw@db.example.com/db",
      RUNNER_TOKEN: GOOD_TOKEN,
    };
    const without = (name: string): Record<string, string | undefined> => ({
      ...base,
      [name]: undefined,
    });

    expect(resolveAppSecret(without("APP_SECRET")).ok).toBe(false);
    expect(() => loadAuthConfig(without("BETTER_AUTH_URL"))).toThrow(
      /BETTER_AUTH_URL/,
    );
    expect(() => loadDatabaseConfig(without("DATABASE_URL"))).toThrow(
      /Postgres/i,
    );
    expect(
      findDeploymentConfigProblems(without("RUNNER_TOKEN")).join(" "),
    ).toContain("RUNNER_TOKEN");
    const cron = new Request(
      "https://app.example.com/api/internal/dispatch-sweep",
    );
    expect(refuseUnlessCron(cron, { APP_RUNTIME: "serverless" })?.status).toBe(
      401,
    );
    for (const name of [
      "APP_SECRET",
      "BETTER_AUTH_URL",
      "DATABASE_URL",
      "RUNNER_TOKEN",
      "CRON_SECRET",
    ])
      expect(row(name).required, name).toMatch(/^yes/);
    // APP_RUNTIME is selected by the platform's own marker, so the code does not demand it: the guide says "set it".
    expect(resolveRuntimeMode({ VERCEL: "1" })).toBe("serverless");
    expect(row("APP_RUNTIME").required).toBe("yes, set it");
    // RUNNER_DISPATCH is `poll` without it: the guide asks for it in step 7 only.
    expect(dispatchConfigProblems({})).toEqual([]);
    expect(row("RUNNER_DISPATCH").required).toContain("in step 7");
  });

  // #333-T04
  it("says what a webhook mode needs, and which of its variables are optional", () => {
    const problems = dispatchConfigProblems({ RUNNER_DISPATCH: "webhook" });

    expect(problems.join(" ")).toContain("RUNNER_WEBHOOK_URL");
    expect(problems.join(" ")).toContain("RUNNER_WEBHOOK_SECRET");
    expect(row("RUNNER_WEBHOOK_URL").required).toBe("with `webhook`");
    expect(row("RUNNER_WEBHOOK_SECRET").required).toBe("with `webhook`");
    // The key id (default k1), the previous key and the bypass token are not needed.
    expect(dispatchConfigProblems(WEBHOOK)).toEqual([]);
    expect(row("RUNNER_WEBHOOK_KEY_ID").required).toBe("optional");
    expect(row("RUNNER_WEBHOOK_KEY_ID").text).toContain("default `k1`");
    expect(row("RUNNER_WEBHOOK_SECRET_PREVIOUS").required).toBe("optional");
    expect(row("RUNNER_WEBHOOK_BYPASS_TOKEN").required).toBe(
      "only if the Dispatcher is protected",
    );
    expect(
      dispatchConfigProblems({
        ...WEBHOOK,
        RUNNER_WEBHOOK_SECRET_PREVIOUS: "p".repeat(40),
      }).join(" "),
    ).toContain("RUNNER_WEBHOOK_KEY_ID_PREVIOUS");
    expect(row("RUNNER_WEBHOOK_SECRET_PREVIOUS").text).toContain(
      "both or neither",
    );
    // The optional ones of the plain App do not stop it from starting.
    expect(findDeploymentConfigProblems({ RUNNER_TOKEN: GOOD_TOKEN })).toEqual(
      [],
    );
    for (const name of [
      "DATABASE_POOL_MAX",
      "RUNNER_DISPATCH_GIVE_UP_SECONDS",
      "OPERATOR_API_TOKEN",
      "REVIEW_DEBOUNCE_SECONDS",
    ])
      expect(row(name).required, name).toBe("optional");
    expect(row("RUNNER_DISPATCH_MAX_RUNNING").required).toBe("**set it**");
  });

  // #333-T04
  it("marks as secret every credential the code knows and what is named like one, and nothing else", () => {
    const credentials = OTHER_CREDENTIAL_VARIABLES.filter((name) =>
      named.includes(name),
    );

    expect(credentials).toEqual(
      expect.arrayContaining([
        "RUNNER_TOKEN",
        "APP_SECRET",
        "OPERATOR_API_TOKEN",
        "CRON_SECRET",
      ]),
    );
    for (const name of credentials)
      expect(row(name).secret, name).toMatch(/^\*\*yes\*\*/);
    for (const candidate of rows)
      for (const name of candidate.names) {
        const isSecret = /^\*\*yes\*\*/.test(candidate.secret);
        // The database URL carries a password; every other secret is named like one.
        const expected =
          name === "DATABASE_URL" ||
          candidate.names.some((each) =>
            /(?:SECRET|TOKEN)(?:_PREVIOUS)?$/.test(each),
          );
        expect(isSecret, name).toBe(expected);
      }
  });

  // #333-T04
  it("states the ranges and defaults of the code", () => {
    expect(row("DATABASE_POOL_MAX").text).toContain(
      `1 to ${String(SERVERLESS_MAX_POOL_MAX)}, default ${String(SERVERLESS_DEFAULT_POOL_MAX)}.`,
    );
    const pool = (value: string) =>
      loadDatabaseConfig({
        APP_RUNTIME: "serverless",
        DATABASE_URL: "postgres://app:pw@db.example.com/db",
        DATABASE_POOL_MAX: value,
      });
    expect(pool(String(SERVERLESS_MAX_POOL_MAX))).toMatchObject({
      poolMax: SERVERLESS_MAX_POOL_MAX,
    });
    expect(() => pool(String(SERVERLESS_MAX_POOL_MAX + 1))).toThrow();
    expect(() => pool("0")).toThrow();

    expect(row("RUNNER_DISPATCH_GIVE_UP_SECONDS").text).toContain(
      `${String(GIVE_UP_SECONDS_RANGE.min)} to ${String(GIVE_UP_SECONDS_RANGE.max)}, default **${String(DEFAULT_GIVE_UP_SECONDS)}** in webhook mode, off in poll mode, \`0\` turns it off`,
    );
    expect(loadSweepSettings({ ...WEBHOOK }).giveUpMs).toBe(
      DEFAULT_GIVE_UP_SECONDS * 1000,
    );
    expect(loadSweepSettings({}).giveUpMs).toBeNull();
    expect(
      loadSweepSettings({ ...WEBHOOK, RUNNER_DISPATCH_GIVE_UP_SECONDS: "0" })
        .giveUpMs,
    ).toBeNull();
    expect(row("RUNNER_DISPATCH_MAX_RUNNING").text).toContain(
      `${String(MAX_RUNNING_RANGE.min)} to ${String(MAX_RUNNING_RANGE.max)}`,
    );
    expect(
      loadSweepSettings({
        ...WEBHOOK,
        RUNNER_DISPATCH_MAX_RUNNING: String(MAX_RUNNING_RANGE.max),
      }).maxRunning,
    ).toBe(MAX_RUNNING_RANGE.max);
    expect(
      loadSweepSettings({
        ...WEBHOOK,
        RUNNER_DISPATCH_MAX_RUNNING: String(MAX_RUNNING_RANGE.max + 1),
      }).maxRunning,
    ).toBeNull();

    expect(row("REVIEW_DEBOUNCE_SECONDS").text).toContain(
      "0 to 600, default 90",
    );
    expect(configuredDebounceMs({})).toBe(90_000);
    expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: "600" })).toBe(
      600_000,
    );
    expect(configuredDebounceMs({ REVIEW_DEBOUNCE_SECONDS: "601" })).toBe(
      90_000,
    );

    for (const name of [
      "APP_SECRET",
      "RUNNER_TOKEN",
      "CRON_SECRET",
      "RUNNER_WEBHOOK_SECRET",
      "OPERATOR_API_TOKEN",
    ])
      expect(row(name).text, name).toContain(
        `At least ${String(MIN_DISPATCH_SECRET_LENGTH)} characters`,
      );
    expect(
      operatorTokenProblem({ OPERATOR_API_TOKEN: "x".repeat(31) }),
    ).not.toBeNull();
    expect(
      operatorTokenProblem({ OPERATOR_API_TOKEN: "x".repeat(32) }),
    ).toBeNull();
    expect(
      dispatchConfigProblems({
        ...WEBHOOK,
        RUNNER_WEBHOOK_SECRET: "x".repeat(31),
      }).length,
    ).toBeGreaterThan(0);
    expect(row("LLM_MODEL").text).toContain("`anthropic/claude-haiku-5.5`");
  });

  // #333-T04
  it("states that the signing secret differs from every other credential, and the code refuses a copy", () => {
    for (const name of OTHER_CREDENTIAL_VARIABLES)
      expect(
        dispatchConfigProblems({
          ...WEBHOOK,
          [name]: WEBHOOK.RUNNER_WEBHOOK_SECRET,
        }).join(" "),
        name,
      ).toContain(name);
    expect(section("### Generating the secrets")).toContain(
      "different from every other secret",
    );
    expect(row("RUNNER_WEBHOOK_SECRET").text).toContain(
      "Different from every other secret",
    );
    expect(row("RUNNER_WEBHOOK_BYPASS_TOKEN").text).toContain(
      "Different from the signing secret",
    );
  });

  // #333-T04
  it("states the setup code's lifetime", () => {
    expect(
      section(
        "### Step 3. The setup code, then the first-run setup in the browser",
      ),
    ).toMatch(
      new RegExp(`valid for ${String(SETUP_CODE_TTL_MS / 60_000)}\\s+minutes`),
    );
  });

  // #333-T04
  it("keeps DATABASE_URL_MIGRATE out of the project's variables and DATABASE_URL off a transaction pooler", () => {
    expect(named).not.toContain("DATABASE_URL_MIGRATE");
    expect(onTheNotSetList("DATABASE_URL_MIGRATE")).toBe(true);
    expect(row("DATABASE_URL").text).toContain(
      "A direct or session-mode connection, never a transaction pooler",
    );
    expect(guide).toContain("withPostgresAdvisoryLock");
    expect(guide).toContain("#371");
  });
});

describe("the hosted deployment guide and vercel.json", () => {
  const appConfig = JSON.parse(read("app/vercel.json")) as {
    regions: string[];
    crons: Array<{ path: string; schedule: string }>;
  };
  const dispatcherConfig = JSON.parse(read("dispatcher/vercel.json")) as {
    regions: string[];
    functions: Record<string, { maxDuration: number }>;
    crons: Array<{ path: string; schedule: string }>;
  };

  // #333-T04
  it("names the region of both projects", () => {
    expect(appConfig.regions).toEqual(["fra1"]);
    expect(dispatcherConfig.regions).toEqual(["fra1"]);
    expect(guide).toContain("`fra1`");
  });

  // #333-T04
  it("names the crons of the App and of the Dispatcher and the function limit", () => {
    for (const { path } of appConfig.crons)
      expect(guide, path).toContain(`\`${path}\``);
    const sweep = appConfig.crons.find(({ path }) =>
      path.endsWith("dispatch-sweep"),
    );
    expect(sweep?.schedule).toBe("* * * * *");
    expect(guide).toMatch(/every\s+minute/);
    expect(guide).toContain(
      `\`maxDuration\` of **${String(dispatcherConfig.functions["src/index.ts"]?.maxDuration)} seconds**`,
    );
    expect(guide).toContain("beta limit");
    expect(dispatcherConfig.crons).toEqual([
      { path: "/api/cron/reap-sandboxes", schedule: "*/5 * * * *" },
    ]);
    expect(guide).toContain("`/api/cron/reap-sandboxes`");
    expect(guide).toMatch(/every 5\s+minutes/);
  });
});

describe("the hosted deployment guide as a procedure", () => {
  const TITLES = [
    "Migrate the database",
    "Deploy the App (still in poll mode)",
    "The setup code, then the first-run setup in the browser",
    "Build the golden snapshot",
    "Deploy the Dispatcher",
    "Run the canary",
    "Switch the App to webhook mode",
    "Smoke test: a Diff review, then a Dynamic review",
  ];
  const step = (number: number): string =>
    section(`### Step ${String(number)}. ${TITLES[number - 1] as string}`);

  // #333-T01
  it("has the steps of the first deployment in the order the work asks for", () => {
    const headings = [...guide.matchAll(/^### (Step \d+\. .+)$/gm)].map(
      (match) => match[1] as string,
    );

    expect(headings).toEqual(
      TITLES.map((title, index) => `Step ${String(index + 1)}. ${title}`),
    );
  });

  // #333-T01
  it("puts into each step what belongs to it, and the webhook only into step 7", () => {
    expect(step(1)).toContain("pnpm --dir app migrate");
    expect(step(1)).toContain("read -rs");
    expect(step(1)).not.toContain("setup-code");

    // Poll mode first: the App is deployed with its cron secret and its address, without any webhook variable.
    expect(step(2)).toContain("`BETTER_AUTH_URL`");
    expect(step(2)).toContain("`CRON_SECRET`");
    expect(step(2)).toContain("production domain");
    expect(flat(step(2))).toContain(
      "**except** the `RUNNER_DISPATCH` and `RUNNER_WEBHOOK_*` ones",
    );
    expect(step(2)).not.toContain("RUNNER_DISPATCH=webhook");
    expect(step(2)).not.toContain("RUNNER_WEBHOOK_URL=");

    expect(step(3)).toContain("pnpm --dir app setup-code");
    expect(step(3)).toContain("/api/webhooks/github-app");
    expect(step(3)).toContain("`/admin/llm`");

    // The snapshot comes before the Dispatcher, and the Dispatcher takes its values from the record.
    expect(step(4)).toContain("golden-snapshot.yml");
    expect(flat(step(4))).toContain(
      "`pinned_snapshot` stays empty on the first run",
    );
    expect(step(4)).toContain("golden-snapshot-record");
    expect(step(4)).not.toContain("SANDBOX_SNAPSHOT_ID");
    expect(flat(step(5))).toContain(
      "`SANDBOX_SNAPSHOT_ID` and `SANDBOX_IMAGE_DIGEST` from the record",
    );
    expect(step(5)).toContain("`CRON_SECRET`");
    expect(step(5)).toContain("`DISPATCHER_CANARY_HOSTS`");
    expect(step(5)).toContain("`RUNNER_API_URL`");

    expect(flat(step(6))).toContain("*Dispatcher canary*");
    expect(step(6)).toContain("POST /probe");
    expect(step(6)).toContain("section 5.1");

    for (const name of [
      "RUNNER_DISPATCH=webhook",
      "RUNNER_WEBHOOK_URL=https://<dispatcher>/dispatch",
      "RUNNER_WEBHOOK_SECRET",
      "RUNNER_WEBHOOK_KEY_ID",
      "RUNNER_DISPATCH_MAX_RUNNING",
    ])
      expect(step(7), name).toContain(name);
    expect(step(7)).toContain("`dispatch_unavailable`");
    expect(step(7)).toContain("Switch soon after step 3");
    expect(step(7)).toContain("RUNNER_DISPATCH_GIVE_UP_SECONDS");

    expect(step(8).indexOf("**Diff.**")).toBeGreaterThanOrEqual(0);
    expect(step(8).indexOf("**Diff.**")).toBeLessThan(
      step(8).indexOf("**Dynamic.**"),
    );
    expect(step(8)).toContain("**Done when:**");
  });

  // #333-T01
  it("explains the database roles with the guide's commands and the safe way to generate secrets", () => {
    const needs = section("## 2. What you need first");

    expect(needs).toContain("version 15 or newer");
    expect(needs).toContain(
      "grant usage, create on schema public to cr_migrate",
    );
    expect(needs).toContain("alter default privileges in schema public");
    expect(needs).not.toContain("alter default privileges for role");
    expect(needs).toContain(
      "grant select, insert, update, delete on all tables in schema public to cr_app",
    );
    expect(needs).toContain("openssl rand -hex 32");
    expect(needs).toContain("transaction pooler");
    expect(flat(needs)).toContain("pooler in **session mode**");
    expect(guide).not.toContain("migrate role's URL first");
    expect(guide).toContain("app/src/db/role-split.integration.test.ts");
    // No secret is typed into a command line or written as an assignment with a value.
    expect(guide).not.toMatch(
      /(?:APP_SECRET|RUNNER_TOKEN|PASSWORD|_PW|SECRET)=['"][^$<'"\s]/,
    );
    expect(guide).not.toMatch(/echo [^\n|]*\| *(?:vercel|gh) /);
    expect(guide).toContain("Prevent self-review");
  });

  // #333-T04
  it("describes the release path with a staged production deployment, not a preview", () => {
    const rebuild = section("### 5.1 Rebuild the snapshot (with a pin)");

    expect(rebuild).toContain("vercel deploy --prod --skip-domain");
    expect(rebuild).toContain("vercel promote");
    expect(rebuild).toContain("`DISPATCHER_CANARY_HOSTS`");
    expect(rebuild).toContain("`VERCEL_AUTOMATION_BYPASS_SECRET`");
    expect(rebuild).toContain("Why not a preview deployment");
    expect(rebuild).not.toMatch(/Deploy the Dispatcher to a preview/);
  });

  // #333-T04
  it("documents the operator's key and managed workspaces as merged", () => {
    const keys = section(
      "### 3.5 LLM keys: a workspace's own, or the operator's",
    );

    expect(keys).toContain("`/admin/llm`");
    expect(keys).toContain('`keyMode: "managed"`');
    expect(keys).toContain("PUT /api/operator/v1/workspaces/{id}/entitlements");
    expect(keys).toContain("Upgrade every App instance first");
    expect(keys).toContain("`llm_not_configured`");
    expect(keys).toContain("`operator_key_missing`");
    expect(flat(keys)).toContain("`LLM_MODEL` and `LLM_MAX_TOKENS` apply");
    expect(guide).not.toMatch(/#276[^\n]*pending/i);
    expect(guide).not.toMatch(/until it merges, every workspace/);
    expect(read("app/src/llm/README.md")).toContain("/admin/llm");
    expect(read("app/src/operator-api/README.md")).toContain(
      "Upgrade every app instance before setting any workspace to `managed`",
    );
  });

  // #333-cron
  it("says that the per-minute cron is required, what is lost without it and how late a debounced review starts", () => {
    const needs = flat(section("## 2. What you need first"));
    const sweep = flat(section("### 5.7 What depends on the per-minute sweep"));
    const appReadme = flat(read("app/src/dispatch/README.md"));

    expect(needs).toContain("The per-minute cron is a hard requirement.");
    expect(needs).toContain("without it push-triggered reviews never start");
    expect(needs).toContain("up to about 60 seconds later");
    // Leases do not stop expiring without the cron: every claim expires the lapsed ones, so it is late, not never.
    expect(needs).toContain(
      "the lease of a Worker that stopped reporting expires only late, when another job happens to be claimed",
    );
    expect(needs).toContain("need the cron only if that first send fails");
    expect(guide).not.toContain("leases never expire");
    expect(guide).not.toContain("nothing else ends it");
    expect(read("app/src/db/repositories/runner-jobs-repository.ts")).toMatch(
      /async claimNext[\s\S]{0,400}await expire\(trx, current\)/,
    );
    expect(needs).toContain(
      "A plan that allows only daily crons cannot run this deployment",
    );
    expect(flat(section("## 1. What you are deploying"))).toContain(
      "is also the only thing that sends the wake-up for a job that is not due yet",
    );
    expect(flat(section("### 3.1 The App project"))).toContain(
      "**push-triggered reviews never start** (section 5.7)",
    );
    expect(sweep).toContain("**Not due yet** when queued");
    expect(sweep).toContain("**Never starts**");
    expect(sweep).toContain(
      "a send that fails is retried only by the sweep** | Works if the first send succeeds; a failed send is never retried",
    );
    expect(sweep).toContain(
      "Expires late: every claim also expires lapsed leases (`claimNext`)",
    );
    expect(sweep).toContain("the debounce plus up to about 60 seconds");
    expect(sweep).toContain("`REVIEW_DEBOUNCE_SECONDS=0`");
    expect(
      flat(
        section("### Step 8. Smoke test: a Diff review, then a Dynamic review"),
      ),
    ).toContain("**Push to the open pull request**");
    expect(
      flat(section("## 9. Known limits and what is not verified")),
    ).toContain(
      "A debounced review starts up to about 60 seconds later than self-hosted",
    );
    // What the guide says is what the App's own documentation says about the sweep and the debounce.
    expect(appReadme).toContain(
      "A job that is not due yet (the 90 second debounce of an automatic review) only gets its row with `next_dispatch_at = run_after`; the sweep sends it when it is due.",
    );
    expect(appReadme).toContain("a debounced job that became due");
    expect(appReadme).toContain(
      "`GET /api/internal/dispatch-sweep`, once a minute",
    );
    expect(configuredDebounceMs({})).toBe(90_000);
  });

  // #333-e2e
  it("points to the hosted e2e lane that exists, no longer calls #332 pending, and states what still relies on the lease after #375", () => {
    const limits = flat(section("## 9. Known limits and what is not verified"));
    const ci = read(".github/workflows/ci.yml");

    expect(ci).toMatch(/^ {2}e2e-hosted:/m);
    expect(read("Makefile")).toMatch(/^test-e2e-hosted:/m);
    expect(read("TESTING.md")).toContain("Hosted e2e lane");
    expect(limits).toContain("the lane **`e2e-hosted`** (#332;");
    expect(limits).toContain("`make test-e2e-hosted`");
    expect(limits).toContain("`E2E_DATABASE_URL`");
    expect(guide).not.toMatch(/#332[^\n]*pending/i);
    expect(guide).not.toMatch(/pending[^\n]*#332/i);
    // #375: a Worker that exits with an error is released at once; the lease stays the safeguard where the end is not seen.
    expect(limits).toContain(
      "A Worker whose end the Dispatcher does not see still holds its slot until its lease lapses",
    );
    expect(limits).toContain("`worker_wait_failed`");
    expect(limits).not.toContain("follow-up #375");
    expect(section("## 10. Follow-ups")).not.toContain("- #375:");
    expect(limits).toContain("on **your** Postgres provider");
  });

  // #333-db-readme
  it("no longer relies on the platform holding traffic back from a deployment that is ahead of the database", () => {
    const readmeOfTheDatabase = flat(read("app/src/db/README.md"));

    expect(readmeOfTheDatabase).not.toContain(
      "keeps routing to the previous deployment",
    );
    expect(readmeOfTheDatabase).toContain(
      "nothing makes the platform hold traffic back",
    );
    expect(
      flat(section("### 5.6 Updating the App or the Dispatcher")),
    ).toContain("Do not rely on the platform to hold traffic back");
  });

  // #333-T04
  it("covers the operations: pin, rotation, the three codes and rollback", () => {
    const operations = section("## 5. Operations");

    expect(operations).toContain("`pinned_snapshot`");
    expect(operations).toContain("### 5.2 Rotating secrets");
    for (const code of [
      "dispatch_unavailable",
      "launch_failed",
      "capability_not_proven",
    ])
      expect(operations, code).toContain(`\`${code}\``);
    expect(guide).toContain("## 7. Rolling back");
  });

  // #333-T04
  it("explains codes that exist: the two on the Runs pages have a text, the third is a launch code", () => {
    expect(ERROR_COPY).toHaveProperty("dispatch_unavailable");
    expect(ERROR_COPY).toHaveProperty("launch_failed");
    expect(read("dispatcher/src/probe/probed-launcher.ts")).toContain(
      '"capability_not_proven"',
    );
    expect(ERROR_COPY).not.toHaveProperty("capability_not_proven");
    expect(
      section("### 5.3 Reading what the Runs page and the logs say"),
    ).toMatch(/Dispatcher log only \| `capability_not_proven`/);
  });

  // #333-T04
  it("keeps the self-hosted path unchanged and does not describe the split as existing", () => {
    const selfHosted = section(
      "## 8. Self-hosted and Coolify: nothing changes",
    );

    expect(selfHosted).toMatch(/`RUNNER_MODE` unset means\s+`legacy`/);
    expect(selfHosted).toContain("#334");
    expect(selfHosted).toContain("nothing to migrate to");
    expect(dispatcherDoc).toMatch(/Poll-Trigger[^\n]*#334 \(not merged\)/);
  });

  // #333-T01
  it("names the prerequisites: plan limits, Postgres with two roles, a separate GitHub App, two projects and the two environments", () => {
    const needs = section("## 2. What you need first");

    expect(needs).toContain("1800 seconds");
    expect(flat(needs)).toContain("**two roles**");
    expect(needs).toContain("`DATABASE_URL_MIGRATE`");
    expect(needs).toContain("**A GitHub App for the hosted instance.**");
    expect(needs).toContain("`app/`");
    expect(needs).toContain("`dispatcher/`");
    expect(needs).toContain("`hosted-snapshot`");
    expect(needs).toContain("`hosted-canary`");
    expect(needs).toContain("`DISPATCHER_CANARY_HOSTS`");
  });
});

describe("the hosted deployment guide as a document", () => {
  const documents = [
    ["docs/deployment-vercel.md", guide],
    ["docs/dispatcher.md", dispatcherDoc],
  ] as const;

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

  // #333-T01
  it("links only to files that exist and to headings that exist", () => {
    const broken: string[] = [];
    for (const [file, text] of documents) {
      const own = anchorsOf(text);
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const link = match[1] as string;
        if (/^https?:/.test(link)) continue;
        const [target, anchor] = link.split("#") as [
          string,
          string | undefined,
        ];
        if (target === "") {
          if (anchor && !own.has(anchor)) broken.push(`${file}: ${link}`);
          continue;
        }
        const path = resolve(repoRoot, "docs", target);
        if (!existsSync(path)) {
          broken.push(`${file}: ${link}`);
          continue;
        }
        if (anchor && !anchorsOf(readFileSync(path, "utf8")).has(anchor))
          broken.push(`${file}: ${link}`);
      }
    }

    expect(broken).toEqual([]);
  });

  // #333-T01
  it("is linked from the README and from the other deployment guides", () => {
    expect(readme).toContain("](docs/deployment-vercel.md)");
    expect(readme).toContain("](docs/dispatcher.md)");
    expect(read("docs/deployment-coolify.md")).toContain(
      "](deployment-vercel.md)",
    );
    expect(read("docs/deployment-large.md")).toContain(
      "](deployment-vercel.md)",
    );
    expect(read("docs/golden-snapshot.md")).toContain(
      "](deployment-vercel.md)",
    );
    expect(read("dispatcher/README.md")).toContain(
      "](../docs/deployment-vercel.md)",
    );
  });

  /** Everything this change added that is public, with the README reduced to its section of the guide. */
  function publicTexts(): Array<readonly [string, string]> {
    const readmeSection = readme.slice(
      readme.indexOf("## Deploy on Vercel (hosted)"),
      readme.indexOf("## Lint, typecheck, test"),
    );
    return [
      ...documents,
      ["dispatcher/.env.example", read("dispatcher/.env.example")],
      ["README.md (Deploy on Vercel)", readmeSection],
    ];
  }

  // #333-T03
  it("holds no account id, snapshot id, image digest, secret shape or em dash", () => {
    for (const [file, text] of publicTexts()) {
      expect(text, file).not.toMatch(/\bsnap_[A-Za-z0-9]{6,}/);
      expect(text, file).not.toMatch(/\b(?:team|prj|usr)_[A-Za-z0-9]{6,}/);
      expect(text, file).not.toMatch(/sha256:[0-9a-f]{64}/);
      expect(text, file).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{30,}/);
      expect(text, file).not.toMatch(/\bvc[a-z]_[A-Za-z0-9]{20,}/);
      expect(text, file).not.toMatch(/\bcrj_[A-Za-z0-9]{10,}/);
      expect(text, file).not.toContain("—");
    }
  });

  // #333-T03
  it("names no price, no company or customer and no personal address", () => {
    for (const [file, text] of publicTexts()) {
      expect(text, file).not.toMatch(/[$€£]\s?\d/);
      expect(text, file).not.toMatch(
        /\b\d[\d.,]*\s?(?:USD|EUR|GBP|dollars?|euros?|cents?)\b/i,
      );
      expect(text, file).not.toMatch(/\b(?:per month|\/month|monthly fee)\b/i);
      expect(text, file).not.toMatch(
        /\b(?:GmbH|Inc\.|Ltd\.?|LLC|Corp\.|S\.A\.|B\.V\.)(?=\W|$)/,
      );
      expect(text, file).not.toMatch(/\bcustomers?\b/i);
      expect(text, file).not.toMatch(
        /[\w.+-]+@(?!example\.com\b|users\.noreply\.github\.com\b)[\w-]+\.\w{2,}/,
      );
    }
  });

  // #333-T03
  it("uses only placeholder host names and the names of the platforms", () => {
    const allowed = new Set([
      "github.com",
      "vercel.com",
      "localhost",
      "127.0.0.1",
    ]);
    for (const [file, text] of publicTexts()) {
      const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.<>_-]+)/gi)].map(
        (match) => (match[1] as string).toLowerCase(),
      );
      for (const host of hosts)
        expect(
          host.startsWith("<") ||
            host === "example.com" ||
            host.endsWith(".example.com") ||
            allowed.has(host),
          `${file}: ${host}`,
        ).toBe(true);
    }
  });
});
