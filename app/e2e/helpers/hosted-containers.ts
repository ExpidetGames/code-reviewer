// SPDX-License-Identifier: Apache-2.0

// Reads the records the `docker` stand-in of the hosted lane (fakes/sandbox/bin/docker-worker.sh) leaves for every
// `docker run`. The stand-in writes `.name`, `.pid` and `.env` first and `run-<n>.args` last, by a rename (#380); the
// reader lists a container by its `.args` and, as a second defence, skips one whose other records are not all there
// yet instead of throwing. A journey polling the list sees the container on the next look; it is not changed for this.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One `docker run` the stand-in saw: a container that was started (or, for the probe, a canary). */
export type Container = {
  /** The order the containers were started in. */
  index: number;
  /** The entry mode: `worker-once` or `probe`. */
  mode: string;
  /** The container's name, `code-reviewer-worker-<job id>` for a job. */
  name: string;
  /** The rendered flags and the image and mode, one argument each. */
  args: string[];
  /** The environment the Worker had, `NAME=value` per line. */
  environment: string;
  /** The Worker's process id; its tree is everything the container runs. */
  pid: number;
  /** What the Worker wrote to stderr (and to stdout, except the probe's verdict). Read when asked. */
  log(): string;
};

/** The records a container has when it is complete, next to its `.args`. */
const REQUIRED_RECORDS = [".name", ".env", ".pid"] as const;

/** The containers in `directory`, oldest first. A container whose records are not all written yet is not listed. */
export function readContainers(directory: string): Container[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => /^run-\d+\.args$/.test(file))
    .sort()
    .map((file) => join(directory, file.slice(0, -".args".length)))
    .filter((base) =>
      REQUIRED_RECORDS.every((extension) => existsSync(`${base}${extension}`)),
    )
    .map((base, index) => {
      const args = readFileSync(`${base}.args`, "utf8").split("\n");
      args.pop();
      return {
        index,
        mode: args.at(-1) ?? "",
        name: readFileSync(`${base}.name`, "utf8"),
        args,
        environment: readFileSync(`${base}.env`, "utf8"),
        pid: Number(readFileSync(`${base}.pid`, "utf8")),
        log: () =>
          existsSync(`${base}.log`) ? readFileSync(`${base}.log`, "utf8") : "",
      };
    });
}
