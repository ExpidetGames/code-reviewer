// SPDX-License-Identifier: LicenseRef-Proprietary

// Checks what `vercel build --prod` wrote when it ran from the repository root with the project's root directory set,
// the way the deployment builds (.github/workflows/vercel-stage.yml), before `vercel deploy --prebuilt` uploads it (#724).
//
//   node tools/vercel/check-build-output.mjs <root directory of the project>      (from the repository root)
//
// The app and the Dispatcher are one pnpm workspace, so the packages of a function live in node_modules/.pnpm at the
// repository root, outside the project's root directory, and the function lists them in `filePathMap` (function path ->
// path in the checkout). The CLI uploads exactly those files. This fails when
//
// 1. the build wrote no function, or a function whose handler is not under the project's root directory (the build did
//    not run for that project), or
// 2. a `filePathMap` entry names a file or directory that is not in the checkout: it would be missing from the upload,
//    and the function would fail on the first request of the deployment.
//
// Nothing is read from the network or from a secret.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDirectory = process.argv[2];
if (!rootDirectory) {
  console.error(
    "usage: node tools/vercel/check-build-output.mjs <root directory of the project>",
  );
  process.exit(2);
}
const functionsDir = resolve(".vercel/output/functions");

function* configs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* configs(path);
    else if (entry.name === ".vc-config.json") yield path;
  }
}

if (!existsSync(functionsDir)) {
  console.error(`error: ${functionsDir} does not exist; run vercel build first`);
  process.exit(1);
}

const failures = [];
let functions = 0;
let entries = 0;
for (const file of configs(functionsDir)) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  functions += 1;
  const handler = String(config.handler ?? "");
  if (!handler.startsWith(`${rootDirectory}/`)) {
    failures.push(
      `${file}: the handler "${handler}" is not under ${rootDirectory}/`,
    );
  }
  for (const source of Object.values(config.filePathMap ?? {})) {
    entries += 1;
    if (!existsSync(resolve(String(source)))) {
      failures.push(`${file}: "${source}" is not in the checkout`);
    }
  }
}

if (functions === 0) failures.push("the build wrote no function");
if (failures.length > 0) {
  console.error(`${failures.length} problem(s):`);
  for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `checked ${functions} function(s) of ${rootDirectory}: ${entries} files to upload, all in the checkout`,
);
