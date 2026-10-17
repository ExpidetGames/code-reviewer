// SPDX-License-Identifier: Apache-2.0

// Starts what `vercel build` wrote for the Dispatcher the way the platform starts it (#416), and fails when it cannot
// answer. `vercel build` alone only proves that the build succeeds: the function it emits is transpiled file by file, so
// a relative import that the emit leaves pointing at a file that is not in the function (a `.ts` specifier next to
// `.js` output) only fails when Node loads the module, on the first request of the deployment.
//
// Run from `dispatcher/` after `vercel build --prod`: `node scripts/check-built-function.mjs`. The function directory
// is `.vercel/output/functions/index.func`, or the first argument. Nothing is read from the network or from a secret:
// the settings below are placeholders, and `GET /health` answers from the process without calling anything.
//
// 1. Every relative import of every emitted file (static `from`, side-effect `import` and `import()`) names a file
//    that exists in the function, so a module that /health does not load cannot fail later either.
// 2. The handler named in `.vc-config.json` loads with the function directory as its root, as the platform's launcher
//    does (`import()` of the handler, the default export is a web handler with `fetch`), and `GET /health` is a 200.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const functionDir = resolve(
  process.argv[2] ?? ".vercel/output/functions/index.func",
);

// Placeholders, not secrets: distinct, 32 characters or more where the Dispatcher asks for it.
const FAKE_ENV = {
  RUNNER_API_URL: "https://app.example.test",
  RUNNER_TOKEN: "fake-runner-token-0123456789abcdef-0123456789abcdef",
  DISPATCHER_MAX_RUNNING: "2",
  DISPATCHER_SIGNING_KEY_ID: "k1",
  DISPATCHER_SIGNING_SECRET:
    "fake-signing-secret-0123456789abcdef-fedcba9876543210",
};

const failures = [];
const fail = (message) => failures.push(message);

function* emittedFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* emittedFiles(path);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) yield path;
  }
}

// `from "./x"`, `import "./x"` and `import("./x")`. Absolute and package specifiers are the platform's business.
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

function checkRelativeImports() {
  let checked = 0;
  for (const file of emittedFiles(functionDir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      checked += 1;
      const specifier = match[1];
      if (!existsSync(resolve(dirname(file), specifier))) {
        fail(
          `${relative(functionDir, file)} imports "${specifier}", which is not in the function`,
        );
      }
    }
  }
  console.log(`checked ${checked} relative imports`);
}

async function checkHealth() {
  const config = JSON.parse(
    readFileSync(join(functionDir, ".vc-config.json"), "utf8"),
  );
  const handlerPath = join(functionDir, config.handler);
  if (!existsSync(handlerPath)) {
    fail(`the handler ${config.handler} is not in the function`);
    return;
  }
  let handler;
  try {
    handler = (await import(pathToFileURL(handlerPath).href)).default;
  } catch (error) {
    fail(`the handler ${config.handler} does not load: ${error}`);
    return;
  }
  if (typeof handler?.fetch !== "function") {
    fail(`the handler ${config.handler} has no default export with fetch`);
    return;
  }
  const response = await handler.fetch(new Request("http://localhost/health"));
  if (response.status !== 200) fail(`GET /health answered ${response.status}`);
  else
    console.log(
      `GET /health answered ${response.status} ${await response.text()}`,
    );
}

if (process.argv[3] === "--child") {
  // The child process: the function directory is its working directory, the environment is the placeholders above.
  checkRelativeImports();
  await checkHealth();
  for (const message of failures) console.error(`error: ${message}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

// A process of its own, so that the loaded handler cannot see anything of this one and nothing it starts stays behind.
const child = spawnSync(
  process.execPath,
  [import.meta.filename, functionDir, "--child"],
  {
    cwd: functionDir,
    env: { PATH: process.env.PATH ?? "", ...FAKE_ENV },
    stdio: "inherit",
    timeout: 60_000,
  },
);
process.exit(child.status ?? 1);
