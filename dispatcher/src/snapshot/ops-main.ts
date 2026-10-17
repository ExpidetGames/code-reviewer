// SPDX-License-Identifier: Apache-2.0

// `pnpm snapshot:ops <decide|persist|cleanup>` (see ops-cli.ts): the one place of these steps that touches the file
// system, git, the process and the real platform SDK. Node strips the types.
import { appendFileSync, readFileSync } from "node:fs";
import { runOps } from "./ops-cli.ts";
import { commitKnown, pathsChanged } from "./git.ts";
import { createVercelService } from "./vercel-service.ts";
import type { SandboxSdk } from "./vercel-service.ts";

const directory = process.cwd();

const code = await runOps(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readText: (path) => readFileSync(path, "utf8"),
  appendText: (path, text) => appendFileSync(path, text),
  commitKnown: (commit) => commitKnown(directory, commit),
  pathsChanged: (from, to, paths) => pathsChanged(directory, from, to, paths),
  createService: async (credentials) => {
    // Loaded here so that nothing else in the Dispatcher, and no test, imports the platform SDK.
    const { Sandbox } = await import("@vercel/sandbox");
    return createVercelService({ Sandbox } satisfies SandboxSdk, credentials);
  },
  fetch,
});
process.exitCode = code;
setTimeout(() => process.exit(code), 10_000).unref();
