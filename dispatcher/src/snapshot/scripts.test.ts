// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "../launchers/container-spec.ts";
import { renderDockerRunArguments } from "../launchers/container.ts";
import { resolveConfig } from "./config.ts";
import {
  PATHS,
  buildImageScript,
  checkNoContainersScript,
  cleanBuilderScript,
  daemonConfigJson,
  installDockerScript,
  installHostScriptsScript,
  inspectImageScript,
  probeRunArguments,
  probeScript,
  scanScript,
  shellQuote,
  startDaemonScript,
  stopDaemonScript,
  writeDaemonConfigScript,
} from "./scripts.ts";

const config = resolveConfig();
const REPO = join(import.meta.dirname, "..", "..", "..");

function syntaxErrors(script: string): string {
  const result = spawnSync("bash", ["-n", "-c", script], { encoding: "utf8" });
  return result.status === 0 ? "" : result.stderr;
}

describe("the scripts the builder VM runs", () => {
  const everyScript: Record<string, string> = {
    installDocker: installDockerScript(config),
    writeDaemonConfig: writeDaemonConfigScript(),
    installHostScripts: installHostScriptsScript(),
    startDaemon: startDaemonScript(),
    buildImage: buildImageScript(config),
    inspectImage: inspectImageScript(config),
    cleanBuilder: cleanBuilderScript(),
    checkNoContainers: checkNoContainersScript(),
    stopDaemon: stopDaemonScript(),
    scan: scanScript(),
    probe: probeScript(config),
  };

  it.each(Object.entries(everyScript))(
    "%s is valid bash and fails on the first error",
    (_name, script) => {
      expect(syntaxErrors(script)).toBe("");
      expect(script).toContain("set -euo pipefail");
    },
  );

  it("quotes a value so that it stays one word", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
    expect(
      execFileSync(
        "bash",
        ["-c", `printf %s ${shellQuote("a b'; echo pwned")}`],
        {
          encoding: "utf8",
        },
      ),
    ).toBe("a b'; echo pwned");
  });

  // #330-T01
  it("installs the pinned Docker and buildx with apt-get and refuses another version", () => {
    const script = installDockerScript(config);
    expect(script).toContain("apt-get install");
    expect(script).toContain(`docker.io=${config.dockerVersion}*`);
    expect(script).toContain(`docker-buildx=${config.buildxVersion}*`);
    expect(script).toContain("dpkg-query");
    expect(script).toMatch(/exit 42/);
  });

  it("writes a daemon.json that keeps IPv6 and its tables off and the container logs small", () => {
    const parsed = JSON.parse(daemonConfigJson()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ipv6: false,
      ip6tables: false,
      "live-restore": false,
    });
    expect(parsed).not.toHaveProperty("hosts");
    expect(parsed).not.toHaveProperty("insecure-registries");
    expect(parsed).not.toHaveProperty("tls");
  });

  it("installs daemon.json and vm-prepare.sh as root-owned files and runs vm-prepare as root", () => {
    expect(writeDaemonConfigScript()).toContain(
      `install -D -m 0644 -o root -g root ${PATHS.daemonJson} /etc/docker/daemon.json`,
    );
    expect(installHostScriptsScript()).toContain(
      `install -D -m 0755 -o root -g root ${PATHS.vmPrepare} ${PATHS.vmPrepareInstalled}`,
    );
    expect(startDaemonScript()).toContain(PATHS.vmPrepareInstalled);
  });

  it("builds the configured target from the extracted commit and prints nothing but the build tail on failure", () => {
    const script = buildImageScript(resolveConfig({ target: "dynamic" }));
    expect(script).toContain("--target 'dynamic'");
    expect(script).toContain("--file 'runner/Dockerfile'");
    expect(script).toContain(`tar xzf ${PATHS.context}`);
    expect(script).toContain("tail -n");
  });

  it("checks every container, not only the running ones", () => {
    expect(checkNoContainersScript()).toContain("docker ps -aq");
  });

  // #330-T04
  it("stops the daemon with SIGTERM, never SIGKILL, and waits until dockerd and containerd are gone", () => {
    const script = stopDaemonScript();
    expect(script).toContain("kill -TERM");
    expect(script).not.toMatch(/kill -(9|KILL)|pkill|killall/);
    expect(script).toContain("dockerd");
    expect(script).toContain("containerd");
    // pgrep sees the kernel's 15-character process name: the shim is "containerd-shim", not its file name.
    expect(script).toContain("pgrep -x 'dockerd|containerd|containerd-shim'");
  });

  it("reads the image id with docker image inspect", () => {
    expect(inspectImageScript(config)).toContain(
      "docker image inspect --format '{{.Id}}'",
    );
  });

  it("removes the build cache and the staged files, then syncs", () => {
    const script = cleanBuilderScript();
    expect(script).toContain("docker builder prune -af");
    expect(script).toContain("rm -rf /tmp/golden-*");
    expect(script).toContain("sync");
  });
});

describe("the container flags of the self-check probe", () => {
  const args = probeRunArguments(config);

  // #330-extra-probe
  it("mirror the hardening of the runner-dynamic service, plus the IPv6 sysctls the reduced ruleset needs", () => {
    const joined = args.join(" ");
    for (const flag of [
      "--user 0:0",
      "--cap-drop ALL",
      "--security-opt no-new-privileges:true",
      "--read-only",
      "--pids-limit 512",
      "--memory 1536m",
      "--memory-swap 1536m",
      "--sysctl net.ipv6.conf.all.disable_ipv6=1",
      "--sysctl net.ipv6.conf.default.disable_ipv6=1",
    ])
      expect(joined, flag).toContain(flag);
    for (const cap of [
      "SETUID",
      "SETGID",
      "KILL",
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "NET_ADMIN",
      "SETPCAP",
    ])
      expect(joined, cap).toContain(`--cap-add ${cap}`);
    expect(args.filter((arg) => arg === "--cap-add")).toHaveLength(8);
  });

  // #330-extra-probe
  it("use the same three tmpfs as compose.coolify.yml, and the compose file lists the same capabilities", () => {
    const compose = readFileSync(join(REPO, "compose.coolify.yml"), "utf8");
    const tmpfs = args.filter((_, index) => args[index - 1] === "--tmpfs");
    expect(tmpfs).toHaveLength(3);
    for (const mount of tmpfs) expect(compose, mount).toContain(mount);
    for (const cap of args.filter(
      (_, index) => args[index - 1] === "--cap-add",
    ))
      expect(compose, cap).toContain(`- ${cap}`);
    expect(compose).toContain("pids_limit: 512");
    expect(compose).toContain("read_only: true");
  });

  // #330-extra-probe
  it("never ask for more than the hardened container spec allows", () => {
    for (const forbidden of [
      "--privileged",
      "--volume",
      "-v",
      "--mount",
      "--device",
      "--pid",
      "--ipc",
      "--userns",
      "--cgroupns",
      "--security-opt=seccomp=unconfined",
      "seccomp=unconfined",
      "apparmor=unconfined",
    ])
      expect(args, forbidden).not.toContain(forbidden);
    expect(args.join(" ")).not.toContain("--network host");
    expect(args.join(" ")).not.toContain("--network=host");
  });

  it("give the probe no token, no URL and no credential, only what its settings read", () => {
    const environment = args.filter((_, index) => args[index - 1] === "--env");
    expect(environment).toEqual([
      "HOME=/home/runner",
      "RUNNER_DIFF_JOB_USER=10001:10001",
    ]);
  });

  // #330-extra-probe
  it("are the output of the shared renderer (#325) for the Sandbox variant, not flags written here", () => {
    expect(args).toEqual(
      renderDockerRunArguments(WORKER_CONTAINER_SPEC, {
        image: config.imageTag,
        environment: {
          HOME: "/home/runner",
          RUNNER_DIFF_JOB_USER: "10001:10001",
        },
        command: ["probe"],
        overrides: {
          memory: { limit: config.probeMemory, swap: config.probeMemory },
        },
        additions: SANDBOX_LAUNCHER_ADDITIONS,
      }),
    );
    expect(args.slice(-2)).toEqual([config.imageTag, "probe"]);
    expect(args.slice(0, 3)).toEqual(["run", "--interactive", "--rm"]);
  });

  it("run the probe mode of the configured image once, with a backstop timeout", () => {
    expect(probeScript(config)).toContain(
      `timeout 180 docker ${args.map(shellQuote).join(" ")}`,
    );
  });
});

describe("the final scan of the restored snapshot", () => {
  let work: string;
  let roots: string;
  let docker: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "golden-scan-"));
    roots = join(work, "root");
    docker = join(work, "docker");
    mkdirSync(join(roots, "home", "ubuntu"), { recursive: true });
    mkdirSync(join(roots, "etc"), { recursive: true });
    mkdirSync(join(docker, "containers"), { recursive: true });
    mkdirSync(join(docker, "volumes"), { recursive: true });
    writeFileSync(join(docker, "volumes", "metadata.db"), "bolt");
    writeFileSync(
      join(roots, "etc", "app.conf"),
      "listen = 8080\nnothing secret here\n",
    );
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  function scan(): string {
    const script = scanScript({ roots: [roots], dockerRoot: docker });
    return execFileSync("bash", ["-c", script], { encoding: "utf8" });
  }

  // #330-T06
  it("finds nothing in a clean tree and ends with its marker", () => {
    expect(scan()).toBe("SCAN_DONE\n");
  });

  // #330-T06
  it.each([
    ["secret_file", ".env", "A=1\n"],
    ["secret_file", ".env.production", "A=1\n"],
    ["secret_file", ".netrc", "machine x\n"],
    ["secret_file", ".git-credentials", "https://u:p@github.com\n"],
    ["secret_file", "id_ed25519", "x\n"],
    ["history", ".bash_history", "export X=1\n"],
    ["private_key", "key.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"],
    ["private_key", "rsa.txt", "-----BEGIN RSA PRIVATE KEY-----\nabc\n"],
    ["token", "gh.txt", `token ghp_${"A1b2".repeat(10)}\n`],
    ["token", "pat.txt", `github_pat_${"a1B2".repeat(8)}\n`],
    [
      "token",
      "or.txt",
      `OPENROUTER=sk-or-v1-${"0123456789abcdef".repeat(2)}\n`,
    ],
    ["token", "job.txt", `Authorization crj_${"abcDEF123-_".repeat(4)}\n`],
    [
      "token",
      "npmrc.txt",
      "//registry.example.org/:_authToken=abcdef0123456789\n",
    ],
    ["token", "env.txt", "RUNNER_TOKEN=abcdefghijklmnop\n"],
  ])(
    "reports a %s (%s) by path and never prints its content",
    (kind, file, content) => {
      const path = join(roots, "home", "ubuntu", file);
      writeFileSync(path, content);
      const out = scan();
      expect(out).toContain(`FINDING ${kind} ${path}\n`);
      expect(out.endsWith("SCAN_DONE\n")).toBe(true);
      for (const word of content.split(/[\s=]/))
        if (word.length >= 16) expect(out).not.toContain(word);
    },
  );

  // #330-T06
  it("reports a Docker config that holds an auth entry, not an empty one, and allows .env.example", () => {
    mkdirSync(join(roots, "home", "ubuntu", ".docker"), { recursive: true });
    const config = join(roots, "home", "ubuntu", ".docker", "config.json");
    writeFileSync(config, '{"auths":{}}');
    writeFileSync(join(roots, "home", "ubuntu", ".env.example"), "A=\n");
    expect(scan()).toBe("SCAN_DONE\n");
    writeFileSync(
      config,
      '{"auths":{"vcr.example.test":{"auth":"dXNlcjpwYXNz"}}}',
    );
    expect(scan()).toContain(`FINDING docker_auth ${config}\n`);
  });

  // #330-T06
  it("reports job data: a container directory or a volume, but not the volume database", () => {
    mkdirSync(join(docker, "containers", "abc123"));
    expect(scan()).toContain(
      `FINDING job_data ${join(docker, "containers", "abc123")}\n`,
    );
    rmSync(join(docker, "containers", "abc123"), { recursive: true });
    expect(scan()).toBe("SCAN_DONE\n");
    mkdirSync(join(docker, "volumes", "vol1"));
    expect(scan()).toContain(
      `FINDING job_data ${join(docker, "volumes", "vol1")}\n`,
    );
  });

  it("skips a root that does not exist", () => {
    const script = scanScript({
      roots: [join(work, "missing")],
      dockerRoot: docker,
    });
    expect(execFileSync("bash", ["-c", script], { encoding: "utf8" })).toBe(
      "SCAN_DONE\n",
    );
  });

  it("is not fooled by a file name with a space or a newline", () => {
    const odd = join(roots, "home", "ubuntu", "my .env");
    writeFileSync(odd, "A=1\n");
    chmodSync(odd, 0o600);
    expect(scan()).toBe("SCAN_DONE\n");
    const tokenFile = join(roots, "home", "ubuntu", "a b.txt");
    writeFileSync(tokenFile, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scan()).toContain(`FINDING token ${tokenFile}\n`);
  });
});
