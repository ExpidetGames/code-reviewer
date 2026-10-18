// SPDX-License-Identifier: Apache-2.0

// Pins down the wiring of the hosted lane (#332): the CI job that runs it, its own Playwright configuration, the
// Worker's container as the privileged lane makes it, and the rules the lane keeps (no skip, no retry, no secret, a
// Postgres server on this machine, the loopback fakes only). That the lane works is its CI run; here the structure is
// judged, so a refactor cannot quietly drop a check, widen the permissions of the job or turn the lane into something
// that skips.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PRODUCTION_CAPABILITIES } from "../../e2e/helpers/dynamic-runner.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
} & Record<string, unknown>;
type Job = {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  services?: Record<string, { image?: string; env?: Record<string, string> }>;
  steps?: Step[];
} & Record<string, unknown>;
type Workflow = { jobs: Record<string, Job> };

const ci = parse(read(".github/workflows/ci.yml")) as Workflow;
const config = read("app/playwright.hosted.config.ts");
const mainConfig = read("app/playwright.config.ts");
const dynamicConfig = read("app/playwright.dynamic.config.ts");
const container = read("runner/scripts/dynamic_e2e_worker_container.sh");
const standIn = read("fakes/sandbox/bin/docker-worker.sh");
const namespace = read("runner/scripts/dynamic_e2e_namespace.sh");
const makefile = read("Makefile");
const dispatcherMain = read("dispatcher/src/test-support/hosted-e2e-main.ts");

function lane(): Job {
  const found = ci.jobs["e2e-hosted"];
  if (!found) throw new Error('ci.yml has no job "e2e-hosted"');
  return found;
}
const steps = (): Step[] => lane().steps ?? [];
const commands = (): string[] =>
  steps().flatMap((step) =>
    (step.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  );

describe("the CI job of the hosted lane", () => {
  // #332-C01
  it("runs the journeys through the package script, for every change of the app, the runner or the Dispatcher and for main", () => {
    expect(commands()).toContain("pnpm test:e2e:hosted");
    expect(read("app/package.json")).toContain(
      '"test:e2e:hosted": "playwright test -c playwright.hosted.config.ts"',
    );
    expect(lane().if).toContain("needs.changes.outputs.app == 'true'");
    expect(lane().if).toContain("needs.changes.outputs.runner == 'true'");
    expect(lane().if).toContain("needs.changes.outputs.dispatcher == 'true'");
    expect(lane().if).toContain("github.base_ref == 'main'");
    expect(lane().if).toContain("github.event_name == 'push'");
    expect(lane().needs).toBe("changes");
  });

  // #332-C02
  it("is a required part of the aggregate check, so a red lane blocks the merge", () => {
    expect(ci.jobs["ci-passed"]?.needs).toContain("e2e-hosted");
  });

  // #332-C03
  it("never lets a failure pass: no continue-on-error, no skipped step, no filter on its tests", () => {
    for (const step of steps())
      expect(step["continue-on-error"]).toBeUndefined();
    expect(commands().join("\n")).not.toMatch(/--grep|\|\| true/);
    expect(config).toContain("retries: 0");
    expect(config).toContain("workers: 1");
  });

  // #332-C04
  it("installs the app, the Dispatcher and the runner from their lockfiles, and the browser", () => {
    const text = steps()
      .map(
        (step) =>
          `${step.uses ?? ""} ${step["working-directory"] ?? ""} ${step.run ?? ""}`,
      )
      .join("\n");

    expect(text).toMatch(/app\s+pnpm install --frozen-lockfile/);
    expect(text).toMatch(/dispatcher\s+pnpm install --frozen-lockfile/);
    expect(text).toContain("uv sync --locked");
    expect(text).toContain("playwright install --with-deps chromium");
    expect(text).toContain("prime_tiktoken_cache.py");
  });

  // #332-C05
  it("is read-only, without secrets, on a hosted runner, time limited, and its Postgres is a service of the job with throwaway credentials", () => {
    expect(lane().permissions).toEqual({ contents: "read" });
    expect(lane()["runs-on"]).toBe("ubuntu-24.04");
    expect(lane()["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(JSON.stringify(lane())).not.toContain("secrets.");
    expect(JSON.stringify(lane())).not.toContain("pull_request_target");
    const checkout = steps().find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    const postgres = lane().services?.postgres;
    expect(postgres?.image).toBe("postgres:18");
    expect(postgres?.env?.POSTGRES_PASSWORD).toBe("postgres");
    const run = steps().find((step) => step.run === "pnpm test:e2e:hosted");
    expect(run?.env?.E2E_DATABASE_URL).toBe(
      "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    );
  });

  // #332-C06
  it("is part of make, next to the other lanes", () => {
    expect(makefile).toContain("test-e2e-hosted:");
    expect(makefile).toContain("$(APP) test:e2e:hosted");
  });
});

describe("the Playwright configuration of the hosted lane", () => {
  // #332-C07
  it("is separate from the one of the other journeys, which never run the lane and are never run by it", () => {
    expect(config).toContain('testDir: "e2e/hosted"');
    expect(mainConfig).toMatch(/testIgnore:[\s\S]*\/e2e\\\/hosted\\\//);
    expect(dynamicConfig).not.toContain('testDir: "e2e/hosted"');
  });

  // #332-C08
  it("runs the app in its serverless mode over Postgres, after `pnpm migrate`, with the dispatch webhook and the cron secret", () => {
    expect(config).toContain('APP_RUNTIME: "serverless"');
    expect(config).toContain("pnpm migrate");
    expect(config.indexOf("pnpm migrate")).toBeLessThan(
      config.indexOf("pnpm start"),
    );
    expect(config).toContain('RUNNER_DISPATCH: "webhook"');
    expect(config).toContain("RUNNER_WEBHOOK_URL");
    expect(config).toContain("CRON_SECRET");
    // The fakes are loopback servers; the lane's app is told where GitHub is and that this is a test.
    expect(config).toContain("ALLOW_TEST_GITHUB_ENDPOINTS");
    expect(config).toContain("fakes/github/main.ts");
    expect(config).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z]/);
  });

  // #332-C09
  it("takes its database from a server on this machine and fails, naming it, without one", () => {
    const env = read("app/e2e/helpers/hosted-env.ts");

    expect(env).toContain("E2E_DATABASE_URL is not set");
    expect(env).toContain('url.hostname !== "127.0.0.1"');
    expect(env).toContain("never a skip");
  });

  // #332-C10
  it("keeps to private ports", () => {
    const env = read("app/e2e/helpers/hosted-env.ts");

    expect(env).toContain("process.env.E2E_HOSTED_PORT) || 3617");
    expect(env).toMatch(/port === 3000 \|\| port === 3100/);
  });
});

describe("the Dispatcher and the Worker of the hosted lane", () => {
  // #332-C11
  it("start the Dispatcher's real Node entry composition over the local mode of the Sandbox double, and nothing of the platform", () => {
    expect(dispatcherMain).toContain("LocalSandboxService");
    expect(dispatcherMain).toContain("startNodeServer");
    expect(dispatcherMain).toContain("createSandboxLauncher");
    expect(dispatcherMain).toContain("withProbeEndpoint");
    expect(dispatcherMain).not.toContain("withCapabilityProbe");
    expect(dispatcherMain).not.toContain("@vercel/sandbox");
  });

  // #332-C12
  it("close the Worker's environment: it is built from the flags, the passed names and a PATH of its own", () => {
    expect(standIn).toContain("env -i");
    expect(standIn).toContain("E2E_WORKER_PASS_");
    expect(standIn).toContain("unknown flag");
  });
});

describe("the Worker's container in the privileged lane", () => {
  // #332-C13
  it("has exactly the capabilities of compose.dynamic.yml, no-new-privileges and a read-only root", () => {
    const named = /--bounding-set=-all,((?:\+[a-z_]+,?)+)/.exec(container)?.[1];
    const capabilities = (named ?? "")
      .split(",")
      .map((name) => name.replace("+", ""))
      .filter((name) => name !== "")
      .sort();

    expect(capabilities).toEqual([...PRODUCTION_CAPABILITIES].sort());
    expect(container).toContain("--inh-caps=-all");
    expect(container).toContain("--no-new-privs");
    // The container's /tmp is where the Worker makes its temporary directories, which the engine user must be able to enter.
    expect(container).toContain("env TMPDIR=/tmp setpriv");
    expect(container).toContain("mount -o remount,bind,ro");
    expect(container).toContain("unshare --mount");
    expect(container).toMatch(/^exec unshare/m);
  });

  // #332-C14
  it("runs the Dispatcher's VMs where the read-only root leaves room, and unsets nothing of the container's environment", () => {
    const journey = read("app/e2e/dynamic/hosted-dynamic.e2e.ts");

    expect(journey).toContain('E2E_VM_ROOT: "/run/hosted-vms"');
    expect(journey).toContain("unsetForWorkerOnce: []");
    expect(journey).toContain("E2E_WORKER_WRAPPER: WRAPPER");
    // /run is a tmpfs of the lane's own, and the container script leaves tmpfs alone.
    expect(namespace).toContain("mount -t tmpfs tmpfs /run");
    expect(container).not.toContain("tmpfs /run");
  });

  // #332-C15
  it("is a project of the privileged lane that runs after the journey of the runner, with its own app", () => {
    expect(dynamicConfig).toContain('name: "hosted"');
    expect(dynamicConfig).toContain("hosted-dynamic");
    expect(dynamicConfig).toContain('dependencies: ["prepare", "journey"]');
    expect(dynamicConfig).toContain('RUNNER_DISPATCH: "webhook"');
    expect(dynamicConfig).not.toMatch(/dynamic_review|DYNAMIC_REVIEW/);
  });
});
