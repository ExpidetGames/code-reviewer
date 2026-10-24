// SPDX-License-Identifier: LicenseRef-Proprietary

// Runs the shell text of one step of a workflow or composite action, as GitHub would (`bash -e`), in a temporary
// directory, with stand-ins for the programs it calls (`curl`, `vercel`, `gh`, `sleep`) first on the PATH. The tests
// of the deployment pipeline (#403) use it to prove what the shell does - the health check's verdicts, what the
// staging step passes to the CLI, what the input checks refuse - instead of only that the text contains a word.
// No network, no platform: a stand-in records its arguments and answers from a script the test wrote.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  readText,
  type CompositeAction,
  type Workflow,
} from "./workflow-support.ts";

export type ShellRun = {
  status: number;
  stdout: string;
  stderr: string;
  /** What the step wrote to $GITHUB_OUTPUT. */
  output: string;
  /** The arguments of every call of a stand-in, one line per call (`NAME arg arg ...`). */
  calls: string[];
  /** A file in the run's temporary directory (RUNNER_TEMP). */
  read(path: string): string;
};

export type StepSelector =
  | { workflow: string; job: string; step: string }
  | { action: string; step: string };

export function stepText(selector: StepSelector): string {
  if ("action" in selector) {
    const action = parse(
      readText(`.github/actions/${selector.action}/action.yml`),
    ) as CompositeAction;
    const step = action.runs.steps.find((s) => s.name === selector.step);
    if (!step?.run) throw new Error(`no run step "${selector.step}"`);
    return step.run;
  }
  const workflow = parse(
    readText(`.github/workflows/${selector.workflow}`),
  ) as Workflow;
  const step = workflow.jobs[selector.job]?.steps?.find(
    (s) => s.name === selector.step,
  );
  if (!step?.run) throw new Error(`no run step "${selector.step}"`);
  return step.run;
}

export function runStep(
  selector: StepSelector,
  options: {
    env?: Record<string, string>;
    /** Stand-ins by program name: the text of a bash script. They may use `$CALLS_FILE` and `$STUB_DIR`. */
    stubs?: Record<string, string>;
    /** Files to create in RUNNER_TEMP before the run. */
    files?: Record<string, string>;
  } = {},
): ShellRun {
  const dir = mkdtempSync(join(tmpdir(), "cr-shell-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const callsFile = join(dir, "calls.log");
    writeFileSync(callsFile, "");
    const stubs: Record<string, string> = {
      sleep: "exit 0",
      ...options.stubs,
    };
    for (const [name, body] of Object.entries(stubs)) {
      const path = join(bin, name);
      writeFileSync(
        path,
        `#!/usr/bin/env bash\nprintf '%s' '${name}' >> "$CALLS_FILE"\nfor a in "$@"; do printf ' %s' "$a" >> "$CALLS_FILE"; done\nprintf '\\n' >> "$CALLS_FILE"\n${body}\n`,
      );
      chmodSync(path, 0o755);
    }
    for (const [name, content] of Object.entries(options.files ?? {}))
      writeFileSync(join(dir, name), content);
    const outputFile = join(dir, "github-output");
    writeFileSync(outputFile, "");
    const script = join(dir, "step.sh");
    writeFileSync(script, stepText(selector));
    const result = spawnSync("bash", ["-e", script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: outputFile,
        GITHUB_ENV: join(dir, "github-env"),
        GITHUB_WORKSPACE: dir,
        GITHUB_REPOSITORY: "example/repository",
        GITHUB_SHA: "2".repeat(40),
        CALLS_FILE: callsFile,
        STUB_DIR: bin,
        ...options.env,
      } as unknown as NodeJS.ProcessEnv,
    });
    // What the step and the stand-ins left in the run's directory, read before it is removed.
    const left = new Map<string, string>();
    for (const folder of ["", "bin"])
      for (const entry of readdirSync(join(dir, folder), {
        withFileTypes: true,
      }))
        if (entry.isFile())
          left.set(
            join(folder, entry.name),
            readFileSync(join(dir, folder, entry.name), "utf8"),
          );
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(outputFile, "utf8"),
      calls: readFileSync(callsFile, "utf8").split("\n").filter(Boolean),
      read: (path) => {
        const content = left.get(path);
        if (content === undefined) throw new Error(`no file ${path}`);
        return content;
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
