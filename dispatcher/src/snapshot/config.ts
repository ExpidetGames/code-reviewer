// SPDX-License-Identifier: Apache-2.0

// What the golden snapshot pipeline can be told (#330). Every value ends up in a shell script that runs as
// root in the builder VM, so each one is checked against a narrow pattern before any script is written; a
// refusal names the field, never the value.
import { SnapshotPipelineError } from "./errors.ts";
import { probeRunArguments } from "./probe-flags.ts";

export type PipelineConfig = {
  /** Snapshots are region-bound and there is no failover region: this is fixed, not an option. */
  region: "fra1";
  /** The builder VM size. The spike used 2 vCPU / 4 GB; the image build is the long step. */
  builderVcpus: number;
  /** The VM the restored snapshot is checked in. */
  checkVcpus: number;
  builderTimeoutMs: number;
  checkTimeoutMs: number;
  /** Pinned apt versions: `docker.io=<version>*`. Another version on the base image fails the run. */
  dockerVersion: string;
  buildxVersion: string;
  /** In the commit's tarball, and the build target of that Dockerfile. */
  dockerfile: string;
  target: string;
  imageTag: string;
  /** The engines the probe of the restored snapshot must advertise. */
  requiredEngines: readonly string[];
  /** The memory limit of the probe container (the spike used 1.5 GB). */
  probeMemory: string;
  /** How many snapshots retention keeps (the current and the previous ones). */
  keep: number;
  /** Snapshot ids retention never removes: the one the Dispatcher is configured with. */
  pinnedSnapshotIds: readonly string[];
};

export const DEFAULT_CONFIG: PipelineConfig = {
  region: "fra1",
  builderVcpus: 2,
  checkVcpus: 2,
  builderTimeoutMs: 30 * 60 * 1000,
  checkTimeoutMs: 15 * 60 * 1000,
  // Ubuntu 26.04's docker.io and docker-buildx as the spike measured them (#317). A change of the base image
  // changes these; the install step then fails with `docker_version_mismatch` instead of snapshotting
  // something nobody tested.
  dockerVersion: "29.1.3",
  buildxVersion: "0.30.1",
  dockerfile: "runner/Dockerfile",
  target: "sandbox",
  imageTag: "code-reviewer-worker:golden",
  requiredEngines: ["pr-agent", "opencode"],
  probeMemory: "1536m",
  keep: 2,
  pinnedSnapshotIds: [],
};

const VERSION = /^\d+\.\d+(\.\d+){0,2}$/;
const PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TARGET = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const IMAGE_TAG = /^[a-z0-9][a-z0-9._/-]{0,62}(:[A-Za-z0-9._-]{1,64})?$/;
const MEMORY = /^[1-9]\d{0,5}[mg]$/;
const ENGINE = /^[a-z][a-z0-9-]{0,31}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{3,128}$/;

function refuse(field: string): never {
  throw new SnapshotPipelineError("configuration_invalid", "configuration", [
    field,
  ]);
}

function text(field: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) refuse(field);
  return value;
}

function integer(
  field: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) refuse(field);
  if (value < min || value > max) refuse(field);
  return value;
}

function list(
  field: string,
  value: unknown,
  pattern: RegExp,
  min: number,
  max: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    refuse(field);
  return value.map((entry) => text(field, entry, pattern));
}

/** The defaults with the given overrides, every value checked. Throws `configuration_invalid` naming the field. */
export function resolveConfig(
  overrides: Partial<PipelineConfig> = {},
): PipelineConfig {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  if (merged.dockerfile.includes("..")) refuse("dockerfile");
  const config: PipelineConfig = {
    region: "fra1",
    builderVcpus: integer("builderVcpus", merged.builderVcpus, 1, 8),
    checkVcpus: integer("checkVcpus", merged.checkVcpus, 1, 8),
    builderTimeoutMs: integer(
      "builderTimeoutMs",
      merged.builderTimeoutMs,
      60_000,
      6 * 3600_000,
    ),
    checkTimeoutMs: integer(
      "checkTimeoutMs",
      merged.checkTimeoutMs,
      60_000,
      6 * 3600_000,
    ),
    dockerVersion: text("dockerVersion", merged.dockerVersion, VERSION),
    buildxVersion: text("buildxVersion", merged.buildxVersion, VERSION),
    dockerfile: text("dockerfile", merged.dockerfile, PATH),
    target: text("target", merged.target, TARGET),
    imageTag: text("imageTag", merged.imageTag, IMAGE_TAG),
    requiredEngines: list(
      "requiredEngines",
      merged.requiredEngines,
      ENGINE,
      1,
      4,
    ),
    probeMemory: text("probeMemory", merged.probeMemory, MEMORY),
    keep: integer("keep", merged.keep, 1, 10),
    pinnedSnapshotIds: list(
      "pinnedSnapshotIds",
      merged.pinnedSnapshotIds,
      SNAPSHOT_ID,
      0,
      10,
    ),
  };
  // The renderer is the judge of the memory limit: a limit the container spec does not allow is refused here,
  // not when the probe is built an hour into a run.
  try {
    probeRunArguments(config);
  } catch {
    refuse("probeMemory");
  }
  return config;
}
