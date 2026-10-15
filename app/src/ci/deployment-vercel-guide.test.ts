// SPDX-License-Identifier: Apache-2.0

// Keeps docs/deployment-vercel.md (the guide for the hosted deployment on Vercel) and docs/dispatcher.md in step
// with the files and the code they describe (#333): every serverless and dispatch variable of .env.example is a
// row of the App table, the table names no variable that .env.example does not know, the stated defaults and
// limits are the code's, the crons and durations are those of the vercel.json files, the steps come in the order the
// issue asks for, the error codes exist, the links resolve, the README and the other deployment guides link to the
// guide, and no account id, snapshot id or digest is in any of these files. What only a real deployment can show is
// listed in the guide's section 9 and stays manual.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVERLESS_DEFAULT_POOL_MAX,
  SERVERLESS_MAX_POOL_MAX,
} from "../db/config.ts";
import { findDeploymentConfigProblems } from "../deploy/startup.ts";
import {
  MIN_DISPATCH_SECRET_LENGTH,
  dispatchConfigProblems,
} from "../dispatch/config.ts";
import {
  DEFAULT_GIVE_UP_SECONDS,
  GIVE_UP_SECONDS_RANGE,
  MAX_RUNNING_RANGE,
} from "../dispatch/sweep-settings.ts";
import { ERROR_COPY } from "../runs/error-copy.ts";
import { SETUP_CODE_TTL_MS } from "../setup/code-store.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

const guide = read("docs/deployment-vercel.md");
const dispatcherDoc = read("docs/dispatcher.md");
const envExample = read(".env.example");
const readme = read("README.md");

/** The text of the section with the given heading, up to the next heading of the same or a higher level. */
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

/** Every variable named in .env.example, set or only shown in a comment. */
function envExampleVariables(): Set<string> {
  return new Set(
    [
      ...envExample.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm),
      ...envExample.matchAll(/^# ([A-Z][A-Z0-9_]*): \S/gm),
    ].map((match) => match[1] as string),
  );
}

/** The variables named in the first cell of the rows of a table. */
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

const HOSTED_VARIABLE =
  /^(APP_RUNTIME|DATABASE_URL_MIGRATE|CRON_SECRET|OPERATOR_API_TOKEN|RUNNER_DISPATCH(_[A-Z_]+)?|RUNNER_WEBHOOK_[A-Z_]+)$/;

describe("the hosted deployment guide and .env.example", () => {
  const appTable = section("### 3.1 The App project");

  // #333-T02
  it("explains every serverless and dispatch variable of .env.example in the App section", () => {
    const hosted = [...envExampleVariables()].filter((name) =>
      HOSTED_VARIABLE.test(name),
    );
    const mentioned = new Set(
      [
        ...section("## 3. Environment variables").matchAll(
          /`([A-Z][A-Z0-9_]+)`/g,
        ),
      ].map((match) => match[1]),
    );

    const missing = hosted.filter((name) => !mentioned.has(name));

    expect(hosted.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  // #333-T04
  it("names in the App table only variables that .env.example knows", () => {
    const known = envExampleVariables();

    const unknown = rowNames(appTable).filter((name) => !known.has(name));

    expect(rowNames(appTable).length).toBeGreaterThan(15);
    expect(unknown).toEqual([]);
  });

  // #333-T04
  it("states the defaults and limits of the code", () => {
    expect(appTable).toMatch(
      new RegExp(
        `DATABASE_POOL_MAX\`[^\\n]*1 to ${String(SERVERLESS_MAX_POOL_MAX)}, default ${String(SERVERLESS_DEFAULT_POOL_MAX)}\\.`,
      ),
    );
    expect(appTable).toMatch(
      new RegExp(
        `RUNNER_DISPATCH_GIVE_UP_SECONDS\`[^\\n]*${String(GIVE_UP_SECONDS_RANGE.min)} to ${String(GIVE_UP_SECONDS_RANGE.max)}, default \\*\\*${String(DEFAULT_GIVE_UP_SECONDS)}\\*\\*`,
      ),
    );
    expect(appTable).toContain(`1 to ${String(MAX_RUNNING_RANGE.max)}`);
    expect(appTable).toContain(
      `At least ${String(MIN_DISPATCH_SECRET_LENGTH)} characters`,
    );
    expect(
      section(
        "### Step 3. The setup code, then the first-run setup in the browser",
      ),
    ).toMatch(
      new RegExp(`valid for ${String(SETUP_CODE_TTL_MS / 60_000)}\\s+minutes`),
    );
  });

  // #333-T04
  it("describes what the App does with an incomplete webhook setup", () => {
    const problems = findDeploymentConfigProblems({
      RUNNER_TOKEN: "r".repeat(40),
      RUNNER_DISPATCH: "webhook",
    });

    expect(problems.join(" ")).toContain("RUNNER_WEBHOOK_URL");
    expect(problems.join(" ")).toContain("RUNNER_WEBHOOK_SECRET");
    expect(guide).toContain("`DEPLOY_CONFIG_INVALID`");
    // A secret that is the same as another credential is refused, which the guide tells.
    expect(
      dispatchConfigProblems({
        RUNNER_DISPATCH: "webhook",
        RUNNER_WEBHOOK_URL: "https://dispatcher.example.com/dispatch",
        RUNNER_WEBHOOK_SECRET: "r".repeat(40),
        RUNNER_TOKEN: "r".repeat(40),
      }).join(" "),
    ).toContain("RUNNER_TOKEN");
    expect(guide).toMatch(
      /refuses a signing secret that equals\s+another credential of the App/,
    );
  });

  // #333-T04
  it("keeps DATABASE_URL_MIGRATE out of the project's variables", () => {
    expect(appTable).not.toMatch(/^\| `DATABASE_URL_MIGRATE`/m);
    expect(section("## 3. Environment variables")).toContain(
      "`DATABASE_URL_MIGRATE`: the direct URL of the **migrate role**",
    );
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
  };

  // #333-T04
  it("names the region of both projects", () => {
    expect(appConfig.regions).toEqual(["fra1"]);
    expect(dispatcherConfig.regions).toEqual(["fra1"]);
    expect(guide).toContain("`fra1`");
  });

  // #333-T04
  it("names the crons of the App and the function limit of the Dispatcher", () => {
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
  });
});

describe("the hosted deployment guide as a procedure", () => {
  // #333-T01
  it("has the steps of the first deployment in the order the work asks for", () => {
    const headings = [...guide.matchAll(/^### (Step \d+\. .+)$/gm)].map(
      (match) => match[1] as string,
    );

    expect(headings).toEqual([
      "Step 1. Migrate the database",
      "Step 2. Deploy the App (still in poll mode)",
      "Step 3. The setup code, then the first-run setup in the browser",
      "Step 4. Build the golden snapshot",
      "Step 5. Deploy the Dispatcher",
      "Step 6. Run the canary",
      "Step 7. Switch the App to webhook mode",
      "Step 8. Smoke test: a Diff review, then a Dynamic review",
    ]);
  });

  // #333-T01
  it("gives the command of every step and of the smoke test", () => {
    const steps = section("## 4. First deployment, step by step");

    expect(steps).toContain("pnpm --dir app migrate");
    expect(steps).toContain("pnpm --dir app setup-code");
    expect(steps).toContain("Golden snapshot");
    expect(steps).toContain("Dispatcher canary");
    expect(steps).toContain("RUNNER_DISPATCH=webhook");
    expect(
      section("### Step 8. Smoke test: a Diff review, then a Dynamic review"),
    ).toContain("**Dynamic.**");
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
    expect(needs).toContain("**two roles**");
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

  // #333-T03
  it("holds no account id, snapshot id, image digest, secret shape or em dash", () => {
    const files: Array<readonly [string, string]> = [
      ...documents,
      ["dispatcher/.env.example", read("dispatcher/.env.example")],
    ];
    for (const [file, text] of files) {
      expect(text, file).not.toMatch(/\bsnap_[A-Za-z0-9]{6,}/);
      expect(text, file).not.toMatch(/\b(?:team|prj)_[A-Za-z0-9]{6,}/);
      expect(text, file).not.toMatch(/sha256:[0-9a-f]{64}/);
      expect(text, file).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{30,}/);
      expect(text, file).not.toMatch(/\bcrj_[A-Za-z0-9]{10,}/);
      expect(text, file).not.toContain("—");
    }
  });

  // #333-T03
  it("uses only placeholder host names", () => {
    for (const [file, text] of documents) {
      const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.<>-]+)/gi)].map(
        (match) => (match[1] as string).toLowerCase(),
      );
      for (const host of hosts)
        expect(
          host.startsWith("<") ||
            host.endsWith("example.com") ||
            ["localhost", "github.com", "vercel.com", "127.0.0.1"].some(
              (allowed) => host === allowed || host.endsWith(`.${allowed}`),
            ),
          `${file}: ${host}`,
        ).toBe(true);
    }
  });
});
