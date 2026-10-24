// SPDX-License-Identifier: LicenseRef-Proprietary

// Makes the database of an installation of the previous release (legacy-installation.ts) for a program that is
// not a test: the image smoke test of the update (docker/smoke/upgrade.sh) and the journey of the update. Node
// runs this file directly (types are stripped; `--conditions=react-server` lets `server-only` pass):
//
//   node --conditions=react-server legacy-installation-cli.ts <database file> <seed.json>
//
// The seed is the JSON of a `LegacySeed`. The file must not exist. Prints one line when it is done.
import { readFileSync } from "node:fs";
import {
  createLegacyInstallation,
  type LegacySeed,
} from "./legacy-installation.ts";

const [databasePath, seedPath] = process.argv.slice(2);
if (!databasePath || !seedPath)
  throw new Error(
    "Usage: legacy-installation-cli.ts <database file> <seed.json>",
  );
const seed = JSON.parse(readFileSync(seedPath, "utf8")) as LegacySeed;
await createLegacyInstallation(databasePath, seed);
console.log(
  `Made the database of an installation before accounts: ${databasePath}`,
);
