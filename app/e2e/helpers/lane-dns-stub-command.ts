// SPDX-License-Identifier: LicenseRef-Proprietary

// Runs the resolver of the privileged Dynamic e2e lane (#667) on 127.0.0.1:53 until it is stopped, appending every
// question to the file given as the argument. Started as root by runner/scripts/dynamic_e2e_namespace.sh.
import { appendFileSync } from "node:fs";
import { startLaneResolver } from "./lane-dns-stub.ts";

const logFile = process.argv[2];
if (logFile === undefined) {
  process.stderr.write("usage: lane-dns-stub-command.ts <log file>\n");
  process.exit(2);
}
await startLaneResolver({
  port: 53,
  onAsked: (line) => {
    appendFileSync(logFile, `${line}\n`);
  },
});
process.stdout.write("ready\n");
process.on("SIGTERM", () => {
  process.exit(0);
});
