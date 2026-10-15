// SPDX-License-Identifier: Apache-2.0

// The scripts the golden snapshot pipeline runs in the VMs (#330), as pure functions of the configuration so
// that a test can read, syntax check and (the scan) run them. Every one starts with `set -euo pipefail`.
// Nothing here carries a secret: the VMs have none, and the only credential of the pipeline, the platform
// token, never leaves the process that calls the platform API.
import type { PipelineConfig } from "./config.ts";

/** The label of each command; the logs, the errors and the Sandbox double address a command by it. */
export const STEPS = {
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
} as const;

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
  if ! pgrep -x 'dockerd|containerd|containerd-shim-runc-v2' > /dev/null; then
    sync
    exit 0
  fi
  sleep 0.2
done
echo "the container engine is still running" >&2
exit 1
`;
}

const DEFAULT_SCAN_ROOTS = [
  "/root",
  "/home",
  "/etc",
  "/opt",
  "/usr/local",
  "/var/tmp",
  "/var/log",
];
const DEFAULT_DOCKER_ROOT = "/var/lib/docker";

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
 */
export function scanScript(
  options: { roots?: readonly string[]; dockerRoot?: string } = {},
): string {
  const roots = options.roots ?? DEFAULT_SCAN_ROOTS;
  const dockerRoot = options.dockerRoot ?? DEFAULT_DOCKER_ROOT;
  const tokenArgs = TOKEN_PATTERNS.map(
    (pattern) => `-e ${shellQuote(pattern)}`,
  ).join(" ");
  return `${STRICT}
roots=(${roots.map(shellQuote).join(" ")})
docker_root=${shellQuote(dockerRoot)}
report() { printf 'FINDING %s %s\\n' "$1" "$2"; }
roots+=("$docker_root/containers" "$docker_root/volumes")
for root in "\${roots[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r -d '' path; do report secret_file "$path"; done < <(find "$root" -xdev -type f \\( -name '.env' -o \\( -name '.env.*' ! -name '.env.example' \\) -o -name '.netrc' -o -name '.git-credentials' -o -name 'id_rsa' -o -name 'id_dsa' -o -name 'id_ecdsa' -o -name 'id_ed25519' \\) -print0 2>/dev/null)
  while IFS= read -r -d '' path; do report history "$path"; done < <(find "$root" -xdev -type f \\( -name '.bash_history' -o -name '.zsh_history' -o -name '.python_history' -o -name '.node_repl_history' \\) -print0 2>/dev/null)
  while IFS= read -r -d '' path; do
    if grep -qE '"(auth|identitytoken|registrytoken)"[[:space:]]*:[[:space:]]*"[^"]+"' "$path" 2>/dev/null; then report docker_auth "$path"; fi
  done < <(find "$root" -xdev -type f -path '*/.docker/config.json' -print0 2>/dev/null)
  while IFS= read -r -d '' path; do report private_key "$path"; done < <(grep -rIlZs --exclude=ssl-cert-snakeoil.key -E -e ${shellQuote(PRIVATE_KEY_PATTERN)} "$root" 2>/dev/null || true)
  while IFS= read -r -d '' path; do report token "$path"; done < <(grep -rIlZs -E ${tokenArgs} "$root" 2>/dev/null || true)
done
for dir in "$docker_root/containers" "$docker_root/volumes"; do
  [ -d "$dir" ] || continue
  while IFS= read -r -d '' path; do report job_data "$path"; done < <(find "$dir" -mindepth 1 -maxdepth 1 ! -name metadata.db -print0 2>/dev/null)
done
echo ${SCAN_DONE}
`;
}

const CAPABILITIES = [
  "SETUID",
  "SETGID",
  "KILL",
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "NET_ADMIN",
  "SETPCAP",
];
const TMPFS = [
  "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777",
  "/run:rw,noexec,nosuid,nodev,size=1m,mode=0755",
  "/home/runner:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
];

/**
 * The flags of the probe container: the hardening of the `runner-dynamic` service of compose.coolify.yml, as
 * the spike (#317) ran it, plus the two IPv6 sysctls that the reduced egress ruleset needs (#345). No volume,
 * device, host namespace or published port, and no environment but what the probe's settings read.
 */
export function probeRunArguments(config: PipelineConfig): string[] {
  return [
    "--rm",
    "--user",
    "0:0",
    "--cap-drop",
    "ALL",
    ...CAPABILITIES.flatMap((capability) => ["--cap-add", capability]),
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    ...TMPFS.flatMap((mount) => ["--tmpfs", mount]),
    "--pids-limit",
    "512",
    "--memory",
    config.probeMemory,
    "--memory-swap",
    config.probeMemory,
    "--stop-timeout",
    "90",
    "--sysctl",
    "net.ipv6.conf.all.disable_ipv6=1",
    "--sysctl",
    "net.ipv6.conf.default.disable_ipv6=1",
    "--env",
    "HOME=/home/runner",
    "--env",
    "RUNNER_DIFF_JOB_USER=10001:10001",
  ];
}

/** Runs the image in `probe` mode (#324): one JSON line, the verdict. The timeout is a backstop. */
export function probeScript(config: PipelineConfig): string {
  return `${STRICT}
timeout 180 docker run ${probeRunArguments(config).map(shellQuote).join(" ")} ${shellQuote(config.imageTag)} probe
`;
}
