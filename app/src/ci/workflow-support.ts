// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads the GitHub Actions files of the repository for the tests that pin the hosted deployment pipeline
// (deploy-production, rollback-production, the canary, the golden snapshot and the Infisical action). Test support
// only: it is not imported by any application code.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The GitHub repository these files belong to. The workflows guard their jobs with it
 * (`github.repository == '...'`) and the community files link to it; the tests read it from here, so a transfer of
 * the repository changes this line and the files, and a test fails for each place that was missed.
 */
export const REPOSITORY = "Itegro-GmbH/code-reviewer";

export type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "working-directory"?: string;
  "continue-on-error"?: boolean;
} & Record<string, unknown>;

export type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  environment?: string;
  permissions?: Record<string, string>;
  concurrency?: unknown;
  steps?: Step[];
  "timeout-minutes"?: number;
  outputs?: Record<string, string>;
} & Record<string, unknown>;

export type Workflow = {
  on: Record<string, unknown>;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, Job>;
};

export type CompositeAction = {
  inputs?: Record<string, { required?: boolean; default?: string }>;
  outputs?: Record<string, { value?: string }>;
  runs: { using: string; steps: Step[] };
};

export function readText(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

export function readWorkflow(file: string): Workflow {
  return parse(readText(`.github/workflows/${file}`)) as Workflow;
}

/** Every workflow file and every composite action file of the repository, as `[path, text]`. */
export function allActionFiles(): Array<[string, string]> {
  const workflows = readdirSync(`${repoRoot}.github/workflows`)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `.github/workflows/${name}`);
  const actions = readdirSync(`${repoRoot}.github/actions`, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `.github/actions/${entry.name}/action.yml`);
  return [...workflows, ...actions].map((path) => [path, readText(path)]);
}

export function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

export function stepsOf(job: Job): Step[] {
  return job.steps ?? [];
}

export function stepIndex(
  job: Job,
  predicate: (step: Step) => boolean,
): number {
  return stepsOf(job).findIndex(predicate);
}

/** The step that loads secrets from Infisical through the shared action. */
export const isInfisicalLoad = (step: Step): boolean =>
  step.uses === "./.github/actions/infisical-ci-secrets";

export const runsVercel = (step: Step, command: string): boolean =>
  new RegExp(`(^|[\\s(])vercel ${command}(\\s|$)`, "m").test(step.run ?? "");
