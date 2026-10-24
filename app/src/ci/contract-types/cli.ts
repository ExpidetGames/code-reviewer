// SPDX-License-Identifier: LicenseRef-Proprietary

// `--write` generates the contract types into app/src/contracts and dispatcher/src/contracts;
// `--check` fails (exit 1, with the command to regenerate) while a committed file differs. Run by
// `make generate-contracts` and `make check-contracts` (part of `make verify`).
//
// Node runs this file as it is (type stripping): relative imports with the .ts extension and no
// TypeScript-only runtime syntax.
import { checkGenerated, writeGenerated } from "./generate.ts";

const mode = process.argv[2];

if (mode === "--write") {
  await writeGenerated();
  console.info("Contract types generated.");
} else if (mode === "--check") {
  const result = await checkGenerated();
  if (result.stale.length > 0) {
    console.error(result.message);
    process.exit(1);
  }
  console.info("Contract types are up to date.");
} else {
  console.error("Usage: cli.ts --write | --check");
  process.exit(2);
}
