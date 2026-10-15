// SPDX-License-Identifier: Apache-2.0

// The scripts the golden snapshot pipeline runs in the VMs (#330), as pure functions of the configuration so
// that a test can read, syntax check and (the scan) run them. Every one starts with `set -euo pipefail`.
// Nothing here carries a secret: the VMs have none, and the only credential of the pipeline, the platform
// token, never leaves the process that calls the platform API.
import type { PipelineConfig } from "./config.ts";
import { probeRunArguments } from "./probe-flags.ts";

export { probeRunArguments };

/** The label of each command; the logs, the errors and the Sandbox double address a command by it. */
export const STEPS = {
  recordBaseManifest: "record_base_manifest",
  installDocker: "install_docker",
  writeDaemonConfig: "write_daemon_config",
  installHostScripts: "install_host_scripts",
  startDaemon: "start_daemon",
  buildImage: "build_image",
  inspectImage: "inspect_image",
  cleanBuilder: "clean_builder",
  checkNoContainers: "check_no_containers",
  stopDaemon: "stop_daemon",
  scanFilesystem: "scan_filesystem",
  startDaemonCheck: "start_daemon_check",
  inspectRestoredImage: "inspect_restored_image",
  probe: "probe",
} as const;

/** Where files go in the VMs. The staged ones share a prefix so one `rm` removes them. */
export const PATHS = {
  daemonJson: "/tmp/golden-daemon.json",
  vmPrepare: "/tmp/golden-vm-prepare.sh",
  context: "/tmp/golden-context.tgz",
  contextDir: "/tmp/golden-ctx",
  buildLog: "/tmp/golden-build.log",
  vmPrepareInstalled: "/usr/local/sbin/vm-prepare.sh",
  // Outside every scan root and outside /tmp (which the clean step empties): it travels in the snapshot to the check VM.
  baseManifest: "/var/lib/code-reviewer-golden/base-manifest",
} as const;

/** Exit status of the scan when the base manifest is missing or empty: the scan cannot tell what the pipeline added. */
export const EXIT_MANIFEST_MISSING = 43;
/** Exit status of the record step when the roots hold no file at all. */
export const EXIT_MANIFEST_EMPTY = 44;
/** Exit status of the install step when the installed docker.io is not the pinned version. */
export const EXIT_VERSION_MISMATCH = 42;
export const SCAN_DONE = "SCAN_DONE";

const STRICT = "set -euo pipefail";

/** One shell word, whatever the value holds. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function installDockerScript(config: PipelineConfig): string {
  const { dockerVersion, buildxVersion } = config;
  return `${STRICT}
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ${shellQuote(`docker.io=${dockerVersion}*`)} ${shellQuote(`docker-buildx=${buildxVersion}*`)}
installed=$(dpkg-query -W -f='\${Version}' docker.io)
case "$installed" in
  ${dockerVersion}*) ;;
  *) echo "docker.io is not the pinned version" >&2; exit ${EXIT_VERSION_MISMATCH} ;;
esac
`;
}

/**
 * The daemon configuration. IPv6 is off (the Worker container turns it off too, and the reduced egress ruleset
 * of kernels with only the `ip` nf_tables family does not cover it) and the platform kernel has no IPv6 tables
 * to program. Nothing opens the daemon to the network: no `hosts`, no TLS, no registry exception.
 */
export function daemonConfigJson(): string {
  return `${JSON.stringify(
    {
      ipv6: false,
      ip6tables: false,
      "live-restore": false,
      "log-opts": { "max-size": "10m", "max-file": "2" },
    },
    null,
    2,
  )}\n`;
}

export function writeDaemonConfigScript(): string {
  return `${STRICT}
install -D -m 0644 -o root -g root ${PATHS.daemonJson} /etc/docker/daemon.json
`;
}

/** vm-prepare.sh (docker/sandbox, #325) goes into the snapshot: the Launcher runs it on every VM start. */
export function installHostScriptsScript(): string {
  return `${STRICT}
install -D -m 0755 -o root -g root ${PATHS.vmPrepare} ${PATHS.vmPrepareInstalled}
`;
}

/** The cgroup preparation and `dockerd`, exactly as the Launcher will start a VM (spike finding F1). */
export function startDaemonScript(): string {
  return `${STRICT}
${PATHS.vmPrepareInstalled}
`;
}

/** Builds the target from the commit's tarball. The build log is kept off the output; only its tail is shown on failure. */
export function buildImageScript(config: PipelineConfig): string {
  return `${STRICT}
rm -rf ${PATHS.contextDir}
mkdir -p ${PATHS.contextDir}
tar xzf ${PATHS.context} -C ${PATHS.contextDir}
cd ${PATHS.contextDir}
if ! DOCKER_BUILDKIT=1 docker build --file ${shellQuote(config.dockerfile)} --target ${shellQuote(config.target)} --tag ${shellQuote(config.imageTag)} . > ${PATHS.buildLog} 2>&1; then
  tail -n 40 ${PATHS.buildLog} >&2
  exit 1
fi
`;
}

export function inspectImageScript(config: PipelineConfig): string {
  return `${STRICT}
docker image inspect --format '{{.Id}}' ${shellQuote(config.imageTag)}
`;
}

/** Leaves the image, drops the build cache and the staged files. */
export function cleanBuilderScript(): string {
  return `${STRICT}
docker builder prune -af > /dev/null
docker image prune -f > /dev/null
rm -rf /tmp/golden-*
apt-get clean
sync
`;
}

/** Prints the id of every container, running or not. */
export function checkNoContainersScript(): string {
  return `${STRICT}
docker ps -aq
`;
}

/** SIGTERM to the daemon, then waits until it, containerd and any shim are gone. Never SIGKILL. */
export function stopDaemonScript(): string {
  return `${STRICT}
pids=$(pgrep -x dockerd || true)
if [ -n "$pids" ]; then
  kill -TERM $pids
fi
for _ in $(seq 1 300); do
  if ! pgrep -x 'dockerd|containerd|containerd-shim' > /dev/null; then
    sync
    exit 0
  fi
  sleep 0.2
done
echo "the container engine is still running" >&2
exit 1
`;
}

/** The directories the pipeline's scan looks into: the record of the base image and the scan share them. */
export const SCAN_ROOTS = [
  "/root",
  "/home",
  "/etc",
  "/opt",
  "/usr/local",
  "/var/tmp",
  "/var/log",
] as const;
const DEFAULT_DOCKER_ROOT = "/var/lib/docker";

// One file per record, NUL separated so that a name with a newline or a tab stays one record: path, size in
// bytes, modification time with its fraction. The record script and the scan both print it, byte for byte alike.
const RECORD_FORMAT = "%p\\t%s\\t%T@\\0";

/**
 * The manifest of the platform's base image (first command of the builder, before anything is installed): the
 * files of the scan roots with their size and modification time, sorted. The scan reports only what is not in
 * it or differs from it, so the files the platform ships (the docs and bundles of its global Node packages hold
 * example keys and placeholder tokens) are not mistaken for something the pipeline left. A file that is new
 * (an apt package, a script of ours) or changed is not in it: it is scanned. Errors of `find` (a file that
 * vanishes at boot) are tolerated: a file missed here is only scanned later, never skipped.
 */
export function recordBaseManifestScript(
  options: { roots?: readonly string[]; manifestPath?: string } = {},
): string {
  const roots = options.roots ?? SCAN_ROOTS;
  const manifest = options.manifestPath ?? PATHS.baseManifest;
  return `${STRICT}
roots=(${roots.map(shellQuote).join(" ")})
manifest=${shellQuote(manifest)}
mkdir -p "$(dirname "$manifest")"
chmod 0700 "$(dirname "$manifest")"
for root in "\${roots[@]}"; do
  [ -d "$root" ] || continue
  find "$root" -xdev -type f -printf '${RECORD_FORMAT}' 2>/dev/null || true
done | LC_ALL=C sort -zu > "$manifest.tmp"
if [ ! -s "$manifest.tmp" ]; then
  rm -f "$manifest.tmp"
  echo "the base image has no file under the scan roots" >&2
  exit ${EXIT_MANIFEST_EMPTY}
fi
mv "$manifest.tmp" "$manifest"
chmod 0600 "$manifest"
sync
`;
}

// High-confidence shapes only: a false finding stops a release. The per-job credential of the Worker API, the
// tokens of the services the product talks to, and assignments of the variables that hold them.
const TOKEN_PATTERNS = [
  "gh[pousr]_[A-Za-z0-9]{36,}",
  "github_pat_[A-Za-z0-9_]{22,}",
  "sk-or-v1-[A-Za-z0-9]{16,}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  "AKIA[0-9A-Z]{16}",
  "xox[abprs]-[A-Za-z0-9-]{10,}",
  "crj_[A-Za-z0-9_-]{20,}",
  "_authToken=[^[:space:]]{8,}",
  "(RUNNER_TOKEN|VERCEL_TOKEN|VERCEL_OIDC_TOKEN|OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN)=[^[:space:]]{8,}",
];
const PRIVATE_KEY_PATTERN = "-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----";

/**
 * The final scan of the restored snapshot: no secret and no job data. It prints `FINDING <kind> <path>` per
 * finding (never a content) and `SCAN_DONE` last; a caller that does not see the marker treats the scan as
 * failed. It reads files only: the daemon need not run. Kinds: secret_file, history, docker_auth,
 * private_key, token, job_data.
 *
 * The file checks cover what the pipeline added or changed since the base manifest (`recordBaseManifestScript`)
 * plus every file of Docker's `containers` and `volumes`. Without the manifest the scan exits with
 * `EXIT_MANIFEST_MISSING` and prints no marker: it never falls back to "nothing to scan". `job_data` is any
 * entry of those two Docker directories except the two artifacts `dockerd` creates in `volumes` at every start:
 * `metadata.db` as a regular file and `backingFsBlockDev` as a block device (a file, a directory or a link of
 * that name is job data).
 */
export function scanScript(
  options: {
    roots?: readonly string[];
    dockerRoot?: string;
    manifestPath?: string;
  } = {},
): string {
  const roots = options.roots ?? SCAN_ROOTS;
  const dockerRoot = options.dockerRoot ?? DEFAULT_DOCKER_ROOT;
  const manifest = options.manifestPath ?? PATHS.baseManifest;
  const tokenArgs = TOKEN_PATTERNS.map(
    (pattern) => `-e ${shellQuote(pattern)}`,
  ).join(" ");
  return `${STRICT}
roots=(${roots.map(shellQuote).join(" ")})
docker_root=${shellQuote(dockerRoot)}
manifest=${shellQuote(manifest)}
report() { printf 'FINDING %s %s\\n' "$1" "$2"; }
if [ ! -s "$manifest" ]; then
  echo "the base manifest is missing or empty" >&2
  exit ${EXIT_MANIFEST_MISSING}
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# The files of the roots now, in the manifest's format; the records that are not in the manifest are the new
# and the changed files. Their paths, and every file of Docker's own data, are what the checks read.
for root in "\${roots[@]}"; do
  [ -d "$root" ] || continue
  find "$root" -xdev -type f -printf '${RECORD_FORMAT}' 2>/dev/null || true
done | LC_ALL=C sort -zu > "$work/current"
LC_ALL=C comm -z -13 "$manifest" "$work/current" | sed -z 's/\\t[0-9]*\\t[0-9.]*$//' > "$work/files"
for dir in "$docker_root/containers" "$docker_root/volumes"; do
  [ -d "$dir" ] || continue
  find "$dir" -xdev -type f -print0 2>/dev/null >> "$work/files" || true
done
while IFS= read -r -d '' path; do
  name=\${path##*/}
  case "$name" in
    .env.example) ;;
    .env|.env.*|.netrc|.git-credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519) report secret_file "$path" ;;
    .bash_history|.zsh_history|.python_history|.node_repl_history) report history "$path" ;;
  esac
  case "$path" in
    */.docker/config.json)
      if grep -qE '"(auth|identitytoken|registrytoken)"[[:space:]]*:[[:space:]]*"[^"]+"' "$path" 2>/dev/null; then report docker_auth "$path"; fi ;;
  esac
done < "$work/files"
while IFS= read -r -d '' path; do report private_key "$path"; done < <(xargs -0 -r -a "$work/files" grep -IlZs --exclude=ssl-cert-snakeoil.key -E -e ${shellQuote(PRIVATE_KEY_PATTERN)} -- 2>/dev/null || true)
while IFS= read -r -d '' path; do report token "$path"; done < <(xargs -0 -r -a "$work/files" grep -IlZs -E ${tokenArgs} -- 2>/dev/null || true)
if [ -d "$docker_root/containers" ]; then
  while IFS= read -r -d '' path; do report job_data "$path"; done < <(find "$docker_root/containers" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
fi
if [ -d "$docker_root/volumes" ]; then
  while IFS= read -r -d '' path; do report job_data "$path"; done < <(find "$docker_root/volumes" -mindepth 1 -maxdepth 1 ! \\( -name metadata.db -type f \\) ! \\( -name backingFsBlockDev -type b \\) -print0 2>/dev/null)
fi
echo ${SCAN_DONE}
`;
}

/** Runs the image in `probe` mode (#324): one JSON line, the verdict. The timeout is a backstop. The flags are the renderer's. */
export function probeScript(config: PipelineConfig): string {
  return `${STRICT}
timeout 180 docker ${probeRunArguments(config).map(shellQuote).join(" ")}
`;
}
