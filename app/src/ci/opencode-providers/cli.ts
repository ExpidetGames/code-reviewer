// SPDX-License-Identifier: Apache-2.0

// `--from <models.dev api.json> --write` derives the supported-provider file from a saved models.dev body and
// `runner/opencode-pin.json` and writes `contracts/opencode-providers.v1.json` and its identical copy in
// `app/src/models-dev/` (the app image holds `app/` only, so it cannot read `contracts/`). `--check` fails while a
// committed file differs from what the body derives. Save the body with `curl -o /tmp/api.json https://models.dev/api.json`.
//
// Node runs this file as it is (type stripping): relative imports with the .ts extension and no TypeScript-only
// runtime syntax.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "prettier";
import { deriveProviders } from "./derive.ts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..", "..");
const TARGETS = [
  join(REPOSITORY, "contracts", "opencode-providers.v1.json"),
  join(REPOSITORY, "app", "src", "models-dev", "opencode-providers.v1.json"),
];

const args = process.argv.slice(2);
const mode = args.find((arg) => arg === "--write" || arg === "--check");
const from = args[args.indexOf("--from") + 1];
if (mode === undefined || args.indexOf("--from") < 0 || from === undefined) {
  console.error("Usage: cli.ts --from <api.json> --write | --check");
  process.exit(2);
}

const pin = JSON.parse(
  await readFile(join(REPOSITORY, "runner", "opencode-pin.json"), "utf8"),
) as { version: string; commit: string };
const body = JSON.parse(await readFile(from, "utf8")) as unknown;
const file = deriveProviders(body, {
  version: pin.version,
  commit: pin.commit,
});
const text = await format(JSON.stringify(file), { parser: "json" });

if (mode === "--write") {
  for (const target of TARGETS) await writeFile(target, text);
  console.info(
    `Wrote ${String(Object.keys(file.providers).length)} providers.`,
  );
} else {
  let stale = false;
  for (const target of TARGETS)
    if ((await readFile(target, "utf8")) !== text) {
      console.error(`${target} differs from what the body derives.`);
      stale = true;
    }
  process.exit(stale ? 1 : 0);
}
