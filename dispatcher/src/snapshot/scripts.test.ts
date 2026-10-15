// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
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
  EXIT_MANIFEST_EMPTY,
  EXIT_MANIFEST_MISSING,
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
  recordBaseManifestScript,
  scanScript,
  SCAN_ROOTS,
  shellQuote,
  startDaemonScript,
  stopDaemonScript,
  writeDaemonConfigScript,
} from "./scripts.ts";

const config = resolveConfig();
const REPO = join(import.meta.dirname, "..", "..", "..");

/** A block device needs root (or CAP_MKNOD): the test that needs one runs where the runner has it, like a CI VM. */
function makeBlockDevice(path: string): boolean {
  return (
    spawnSync("mknod", [path, "b", "254", "16"], { stdio: "ignore" }).status ===
    0
  );
}

function canMakeBlockDevice(dir: string): boolean {
  const probe = join(mkdtempSync(join(dir, "golden-mknod-")), "probe");
  const made = makeBlockDevice(probe);
  rmSync(join(probe, ".."), { recursive: true, force: true });
  return made;
}

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
    recordBaseManifest: recordBaseManifestScript(),
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
  let manifest: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "golden-scan-"));
    roots = join(work, "root");
    docker = join(work, "docker");
    manifest = join(work, "base-manifest");
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

  /** The builder's first command, on the base layer as it is now: what is written later is the pipeline's. */
  function recordBase(): void {
    execFileSync(
      "bash",
      [
        "-c",
        recordBaseManifestScript({ roots: [roots], manifestPath: manifest }),
      ],
      { encoding: "utf8" },
    );
  }

  function scanOutput(): string {
    const script = scanScript({
      roots: [roots],
      dockerRoot: docker,
      manifestPath: manifest,
    });
    return execFileSync("bash", ["-c", script], { encoding: "utf8" });
  }

  /** The scan as the check VM runs it: after the base was recorded, over what the pipeline then wrote. */
  function scan(): string {
    if (!existsSync(manifest)) recordBase();
    return scanOutput();
  }

  const DOC_EXAMPLES: Record<string, string> = {
    "config.md": "Set `key` to a PEM file:\n-----BEGIN PRIVATE KEY-----\n",
    "npmrc.md": "//registry.example.org/:_authToken=MYTOKEN1\n",
    "CHANGELOG.md": "//reg.example.org/:_authToken=${ORG_A_TOKEN}\n",
    "AssumeRoleCommand.d.ts": "@example accessKeyId: AKIAIOSFODNN7EXAMPLE\n",
    "pnpm.mjs": "var x = 'AKIAUEFSCETA0ACQCAKI';\n",
  };

  /** A base image layer as the platform ships it: global Node packages whose docs and bundles hold example secrets. */
  function writeBaseImageLayer(): string {
    const packages = join(roots, "usr", "local", "lib", "node_modules", "npm");
    mkdirSync(join(packages, "docs"), { recursive: true });
    for (const [file, content] of Object.entries(DOC_EXAMPLES))
      writeFileSync(join(packages, "docs", file), content);
    return packages;
  }

  // #357-T12
  it("finds nothing in a clean tree and ends with its marker", () => {
    expect(scan()).toBe("SCAN_DONE\n");
  });

  // #357-T12
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
    "reports a %s (%s) written after the base was recorded, by path, and never prints its content",
    (kind, file, content) => {
      recordBase();
      const path = join(roots, "home", "ubuntu", file);
      writeFileSync(path, content);
      const out = scan();
      expect(out).toContain(`FINDING ${kind} ${path}\n`);
      expect(out.endsWith("SCAN_DONE\n")).toBe(true);
      for (const word of content.split(/[\s=]/))
        if (word.length >= 16) expect(out).not.toContain(word);
    },
  );

  // #357-T12
  it("reports a Docker config that holds an auth entry, not an empty one, and allows .env.example", () => {
    recordBase();
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

  // #357-T12
  it("allows the distribution's snake-oil key and reports any other key of the same shape", () => {
    recordBase();
    mkdirSync(join(roots, "etc", "ssl"), { recursive: true });
    writeFileSync(
      join(roots, "etc", "ssl", "ssl-cert-snakeoil.key"),
      "-----BEGIN PRIVATE KEY-----\nabc\n",
    );
    expect(scan()).toBe("SCAN_DONE\n");
  });

  describe("what the platform's base image ships", () => {
    // #357-T01
    it("is not reported: documentation and bundles with an example key, a PEM header and placeholder tokens", () => {
      writeBaseImageLayer();
      recordBase();
      expect(scanOutput()).toBe("SCAN_DONE\n");
    });

    // #357-T01
    it("is skipped while the pipeline's own files next to it are still scanned", () => {
      writeBaseImageLayer();
      recordBase();
      const planted = join(roots, "home", "ubuntu", "leak.txt");
      writeFileSync(planted, `ghp_${"A1b2".repeat(10)}\n`);
      expect(scanOutput()).toBe(`FINDING token ${planted}\nSCAN_DONE\n`);
    });
  });

  describe("what the pipeline adds or changes", () => {
    // #357-T02
    it("reports a secret planted in a new file in a base-image directory", () => {
      const packages = writeBaseImageLayer();
      recordBase();
      const planted = join(packages, "docs", "new.md");
      writeFileSync(planted, `RUNNER_TOKEN=${"x1y2z3".repeat(4)}\n`);
      expect(scanOutput()).toBe(`FINDING token ${planted}\nSCAN_DONE\n`);
    });

    // #357-T03
    it("reports a base file that grew to hold a secret", () => {
      const packages = writeBaseImageLayer();
      recordBase();
      const file = join(packages, "docs", "npmrc.md");
      appendFileSync(file, `ghp_${"A1b2".repeat(10)}\n`);
      expect(scanOutput()).toContain(`FINDING token ${file}\n`);
    });

    // #357-T03
    it("reports a base file rewritten to the same size with a newer time", () => {
      writeBaseImageLayer();
      const file = join(roots, "etc", "app.conf");
      writeFileSync(
        file,
        `${"# a base file, long enough for a token\n".repeat(2)}`,
      );
      recordBase();
      const old = readFileSync(file, "utf8");
      const replaced = `ghp_${"A1b2".repeat(10)}`.padEnd(old.length, "\n");
      expect(replaced.length).toBe(old.length);
      writeFileSync(file, replaced);
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(scanOutput()).toContain(`FINDING token ${file}\n`);
    });

    // #357-T04
    it("reports a documented example key in a file the pipeline wrote", () => {
      recordBase();
      const written = join(roots, "etc", "docker-notes.txt");
      writeFileSync(written, "key AKIAIOSFODNN7EXAMPLE\n");
      expect(scanOutput()).toBe(`FINDING token ${written}\nSCAN_DONE\n`);
    });

    // #357-T04
    it("reports a PEM header and a placeholder token in files the pipeline wrote", () => {
      recordBase();
      const pem = join(roots, "etc", "ca.pem");
      const rc = join(roots, "home", "ubuntu", ".npmrc");
      writeFileSync(pem, "-----BEGIN PRIVATE KEY-----\nabc\n");
      writeFileSync(rc, "//registry.example.org/:_authToken=MYTOKEN1\n");
      const out = scanOutput();
      expect(out).toContain(`FINDING private_key ${pem}\n`);
      expect(out).toContain(`FINDING token ${rc}\n`);
    });

    // #357-T04
    it("skips nothing that is only a file of the same name as a base file", () => {
      writeBaseImageLayer();
      recordBase();
      const elsewhere = join(roots, "home", "ubuntu", "npmrc.md");
      writeFileSync(elsewhere, DOC_EXAMPLES["npmrc.md"] ?? "");
      expect(scanOutput()).toContain(`FINDING token ${elsewhere}\n`);
    });

    // #357-T09
    it("does not report a file that was removed after the record", () => {
      writeBaseImageLayer();
      recordBase();
      rmSync(join(roots, "usr", "local", "lib", "node_modules"), {
        recursive: true,
      });
      expect(scanOutput()).toBe("SCAN_DONE\n");
    });
  });

  describe("the base manifest", () => {
    // #357-T07
    it("makes the scan fail without a marker when it is missing", () => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          scanScript({
            roots: [roots],
            dockerRoot: docker,
            manifestPath: join(work, "no-such-manifest"),
          }),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(EXIT_MANIFEST_MISSING);
      expect(result.stdout).not.toContain("SCAN_DONE");
    });

    // #357-T07
    it("makes the scan fail without a marker when it is empty", () => {
      writeFileSync(manifest, "");
      const result = spawnSync(
        "bash",
        [
          "-c",
          scanScript({
            roots: [roots],
            dockerRoot: docker,
            manifestPath: manifest,
          }),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(EXIT_MANIFEST_MISSING);
      expect(result.stdout).not.toContain("SCAN_DONE");
    });

    // #357-T07
    it("is refused by the record step when the roots hold no file", () => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          recordBaseManifestScript({
            roots: [join(work, "missing")],
            manifestPath: manifest,
          }),
        ],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(EXIT_MANIFEST_EMPTY);
      expect(existsSync(manifest)).toBe(false);
    });

    // #357-T09
    it("lists each file once with its size and time, one NUL terminated record per file", () => {
      recordBase();
      const records = readFileSync(manifest, "utf8").split("\0");
      expect(records.pop()).toBe("");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatch(
        new RegExp(
          `^${join(roots, "etc", "app.conf").replaceAll(".", "\\.")}\t${statSync(join(roots, "etc", "app.conf")).size}\t\\d+\\.\\d+$`,
        ),
      );
      expect(readFileSync(manifest, "utf8")).not.toContain("SCAN_DONE");
    });

    // #357-T09
    it("is recorded and scanned over the same roots by default", () => {
      const roots = [...SCAN_ROOTS].map((root) => shellQuote(root)).join(" ");
      expect(recordBaseManifestScript()).toContain(`roots=(${roots})`);
      expect(scanScript()).toContain(`roots=(${roots})`);
      expect(recordBaseManifestScript()).toContain(PATHS.baseManifest);
      expect(scanScript()).toContain(PATHS.baseManifest);
    });

    // #357-T09
    it("lies outside the scan roots and outside the staged files the clean step removes", () => {
      for (const root of SCAN_ROOTS)
        expect(PATHS.baseManifest.startsWith(`${root}/`)).toBe(false);
      expect(PATHS.baseManifest.startsWith("/tmp/")).toBe(false);
    });
  });

  describe("Docker's own data", () => {
    // #357-T05
    it("allows the volume database as a regular file and nothing else of the two directories empty", () => {
      expect(scan()).toBe("SCAN_DONE\n");
    });

    // #357-T05
    it.skipIf(!canMakeBlockDevice(tmpdir()))(
      "allows the block device dockerd creates in volumes at every start",
      () => {
        makeBlockDevice(join(docker, "volumes", "backingFsBlockDev"));
        expect(scan()).toBe("SCAN_DONE\n");
      },
    );

    // #357-T06
    it("reports a container directory or a volume, but not the volume database", () => {
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

    // #357-T06
    it.each([
      [
        "a regular file",
        (path: string) => writeFileSync(path, "not a device\n"),
      ],
      ["a directory", (path: string) => mkdirSync(path)],
      ["a symbolic link", (path: string) => symlinkSync("/dev/null", path)],
    ])(
      "reports %s named backingFsBlockDev: only a block device is Docker's own",
      (_what, create) => {
        const path = join(docker, "volumes", "backingFsBlockDev");
        create(path);
        expect(scan()).toContain(`FINDING job_data ${path}\n`);
      },
    );

    // #357-T06
    it("reports a volume database that is not a regular file, and a database in the container directory", () => {
      rmSync(join(docker, "volumes", "metadata.db"));
      mkdirSync(join(docker, "volumes", "metadata.db"));
      expect(scan()).toContain(
        `FINDING job_data ${join(docker, "volumes", "metadata.db")}\n`,
      );
      rmSync(join(docker, "volumes", "metadata.db"), { recursive: true });
      writeFileSync(join(docker, "containers", "metadata.db"), "bolt");
      expect(scan()).toContain(
        `FINDING job_data ${join(docker, "containers", "metadata.db")}\n`,
      );
    });

    // #357-T06
    it("reads every file of the container and volume directories, new or not", () => {
      mkdirSync(join(docker, "volumes", "vol1"));
      const leak = join(docker, "volumes", "vol1", "out.txt");
      writeFileSync(leak, `ghp_${"A1b2".repeat(10)}\n`);
      recordBase();
      const out = scanOutput();
      expect(out).toContain(`FINDING token ${leak}\n`);
      expect(out).toContain(
        `FINDING job_data ${join(docker, "volumes", "vol1")}\n`,
      );
    });
  });

  it("skips a root that does not exist", () => {
    recordBase();
    const script = scanScript({
      roots: [join(work, "missing"), roots],
      dockerRoot: docker,
      manifestPath: manifest,
    });
    expect(execFileSync("bash", ["-c", script], { encoding: "utf8" })).toBe(
      "SCAN_DONE\n",
    );
  });

  // #357-T08
  it("is not fooled by a file name with a space, a tab or a newline", () => {
    recordBase();
    const odd = join(roots, "home", "ubuntu", "my .env");
    writeFileSync(odd, "A=1\n");
    chmodSync(odd, 0o600);
    expect(scan()).toBe("SCAN_DONE\n");
    const tokenFile = join(roots, "home", "ubuntu", "a b.txt");
    writeFileSync(tokenFile, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scan()).toContain(`FINDING token ${tokenFile}\n`);
    const tabbed = join(roots, "home", "ubuntu", "t\t5\t1.5.txt");
    writeFileSync(tabbed, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scan()).toContain(`FINDING token ${tabbed}\n`);
    const lined = join(roots, "home", "ubuntu", "new\nline.txt");
    writeFileSync(lined, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scan()).toContain(`FINDING token ${lined}\n`);
  });

  // #357-T08
  it("is not fooled by a base file with an odd name that changed", () => {
    const lined = join(roots, "home", "ubuntu", "base\n5\nfile.txt");
    writeFileSync(lined, "plain\n");
    recordBase();
    expect(scanOutput()).toBe("SCAN_DONE\n");
    appendFileSync(lined, `ghp_${"A1b2".repeat(10)}\n`);
    expect(scanOutput()).toContain(`FINDING token ${lined}\n`);
  });
});
