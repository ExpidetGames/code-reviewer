// SPDX-License-Identifier: Apache-2.0

// Pins down compose.dynamic.yml as a file (#202): the opt-in second runner for Dynamic Review. It is
// an override file like compose.build.yml, so nothing in compose.yml, compose.coolify.yml or
// compose.large.yml changes and a default installation never starts it. It adds one service with
// one Dynamic slot, a memory limit that fits it, a hardened container and no secret. Whether the
// engine really runs in it is the image smoke test and the engine suite (#197), not a file test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

type Service = {
  image?: string;
  build?: { context?: string; dockerfile?: string; target?: string };
  restart?: string;
  ports?: string[];
  profiles?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  mem_limit?: string;
  mem_reservation?: string;
  memswap_limit?: string;
  pids_limit?: number | string;
  cap_drop?: string[];
  cap_add?: string[];
  volumes?: unknown;
  read_only?: boolean;
  tmpfs?: string[];
  user?: string;
  privileged?: boolean;
  security_opt?: string[];
  userns_mode?: string;
  sysctls?: unknown;
  configs?: unknown;
  secrets?: unknown;
  extends?: unknown;
  stop_grace_period?: string;
  entrypoint?: unknown;
  command?: unknown;
};
type Compose = { services: Record<string, Service> };

const source = read("compose.dynamic.yml");
const privilegedScript = read("runner/scripts/run_privileged_offline.sh");
const smokeScript = read("docker/smoke/runner.sh");
const phasesScript = read("runner/scripts/privileged_phases.sh");
// What the root supervisor of the Dynamic job needs for its whole life (#197): launch the engine as
// another user (SETUID, SETGID), end what that user runs (KILL) and seal and remove the export
// (CHOWN, DAC_OVERRIDE, FOWNER).
const SUPERVISOR_CAPABILITIES = [
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "KILL",
  "SETGID",
  "SETUID",
];
// What only the startup of the container holds (#244, ADR 0003): NET_ADMIN installs the engine
// user's static nft rules once, SETPCAP is what allows dropping NET_ADMIN from the bounding set.
// Both are dropped for good before the job loop runs, so the container has to be created with them
// and no process holds them afterwards.
const STARTUP_ONLY_CAPABILITIES = ["NET_ADMIN", "SETPCAP"];
const CREATED_WITH = [
  ...SUPERVISOR_CAPABILITIES,
  ...STARTUP_ONLY_CAPABILITIES,
].sort();
// The only writable paths of the container (#249): the root filesystem is read-only, so a root
// supervisor that is compromised cannot change `nft`, `tini` or the runner source for the restart
// that gives `NET_ADMIN` back (ADR 0003, decision 5). Each is a tmpfs, so it is empty again after a
// restart, and each is as tight as it can be:
//  * /tmp          the job working directories, the per-job export and the engine's HOME, XDG and
//                  TMPDIR. World-writable with the sticky bit, exactly as /tmp is in the image: the
//                  engine user could write there before and gains nothing.
//  * /run          the identity leases of the checkout. Root only (0755): the engine user cannot
//                  write there.
//  * /home/runner  the HOME of the Diff job user 10001 and of the loop. 10001 only (0700): not
//                  writable, not even enterable, for the engine user.
// Memory: a tmpfs is charged to the container's memory limit, so the sizes are deliberate.
const READ_ONLY_TMPFS = [
  "/home/runner:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
  "/run:rw,noexec,nosuid,nodev,size=1m,mode=0755",
  "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777",
];
const dynamic = parse(source) as Compose;
const plain = parse(read("compose.yml")) as Compose;

function runnerDynamic(): Service {
  const found = dynamic.services["runner-dynamic"];
  if (!found)
    throw new Error('compose.dynamic.yml has no service "runner-dynamic"');
  return found;
}

/** The number of bytes of a Docker memory value such as `2g` or `1536m`. */
function bytes(value: string): number {
  const match = /^(\d+)([kmg]?)$/i.exec(value);
  if (!match) throw new Error(`not a memory value: ${value}`);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    (match[2] ?? "").toLowerCase() as "" | "k" | "m" | "g"
  ];
  return Number(match[1]) * unit;
}

/** The default of `${NAME:-default}`. */
/** A `tmpfs` entry as its path and its comma separated options. */
function splitTmpfs(entry: string): { path: string; options: string[] } {
  const colon = entry.indexOf(":");
  return {
    path: entry.slice(0, colon),
    options: entry.slice(colon + 1).split(","),
  };
}

function defaultOf(reference: string | undefined): string {
  const match = /^\$\{[A-Z0-9_]+:-([^}]*)\}$/.exec(reference ?? "");
  if (!match) throw new Error(`no default in ${reference}`);
  return match[1] ?? "";
}

describe("compose.dynamic.yml", () => {
  // #202-T08
  it("adds exactly one service, the Dynamic runner, and changes none of the existing ones", () => {
    expect(Object.keys(dynamic.services)).toEqual(["runner-dynamic"]);
    expect(plain.services).not.toHaveProperty("runner-dynamic");
  });

  // #202-T08
  it("is opt-in: a file of its own, not a profile that a stray flag could switch on", () => {
    expect(runnerDynamic()).not.toHaveProperty("profiles");
    expect(read("compose.yml")).not.toContain("runner-dynamic");
    expect(read("compose.coolify.yml")).not.toContain("runner-dynamic");
    expect(read("compose.large.yml")).not.toContain("runner-dynamic");
  });

  // #202-T08
  it("builds the dynamic target of the runner Dockerfile from the checkout, under an image name of its own", () => {
    const service = runnerDynamic();

    // The Dynamic image differs from the Diff one (it carries the engine), so it has a variable and
    // a tag of its own; like the other topologies it is built from this checkout, not pulled.
    expect(service.image).toBe(
      "${RUNNER_DYNAMIC_IMAGE:-code-reviewer-runner-dynamic:local}",
    );
    expect(service.build).toEqual({
      context: ".",
      dockerfile: "runner/Dockerfile",
      target: "dynamic",
    });
    expect(plain.services.runner?.image).not.toContain("dynamic");
  });

  // #202-T05
  it("runs one Dynamic job at a time by default", () => {
    const environment = runnerDynamic().environment ?? {};

    expect(defaultOf(environment.RUNNER_CONCURRENCY)).toBe("1");
    expect(environment.RUNNER_CONCURRENCY).toContain(
      "RUNNER_DYNAMIC_CONCURRENCY",
    );
  });

  // #202-T10
  it("gives each Dynamic slot at least 1 GiB plus a reserve for the runner, and no swap", () => {
    const service = runnerDynamic();
    const limit = bytes(defaultOf(service.mem_limit));

    // The spike's conservative proposal: 1 GiB per Dynamic slot plus the runner and proxy reserve.
    expect(limit).toBeGreaterThanOrEqual(2 * 1024 ** 3);
    expect(bytes(defaultOf(service.mem_reservation))).toBeGreaterThanOrEqual(
      1.5 * 1024 ** 3,
    );
    expect(bytes(defaultOf(service.mem_reservation))).toBeLessThan(limit);
    // Swap would hide the cgroup peak the OOM matrix is meant to measure.
    expect(service.memswap_limit).toBe(service.mem_limit);
  });

  // #197-T04 #202-T08 #244-T13
  it("runs the supervisor as root with exactly the capabilities it needs and no privilege escalation", () => {
    const service = runnerDynamic();

    // The job process is the root supervisor (it starts the engine as another user); everything
    // else is dropped, and no-new-privileges means nothing can regain a capability. The two
    // startup-only capabilities are listed because the container is created with this set; the
    // runner drops them in-process before its loop (next test).
    expect(service.user).toBe("0:0");
    expect(service.cap_drop).toEqual(["ALL"]);
    expect([...(service.cap_add ?? [])].sort()).toEqual(CREATED_WITH);
    for (const forbidden of [
      "SYS_ADMIN",
      "SYS_PTRACE",
      "SYS_MODULE",
      "NET_RAW",
      "NET_BIND_SERVICE",
      "MKNOD",
    ]) {
      expect(service.cap_add).not.toContain(forbidden);
    }
    // cap_add and cap_drop are compared exactly above, so a capability such as SYS_ADMIN fails
    // there; the loop only documents the ones that matter most, add no further per-name check.
    expect(service.privileged).not.toBe(true);
    // Exactly this, nothing else: seccomp=unconfined, apparmor=unconfined, systempaths=unconfined
    // and label=disable would each widen what the container's processes can do.
    expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    expect(Number(service.pids_limit)).toBeGreaterThan(0);
    expect(Number(service.pids_limit)).toBeLessThanOrEqual(1024);
  });

  // #244-T13
  it("lists NET_ADMIN and SETPCAP as startup-only and says the runner drops them", () => {
    const lines = source.split("\n");
    const comment = lines
      .slice(
        lines.findIndex((line) => line.includes("STARTUP ONLY")),
        lines.findIndex((line) => line.includes("- NET_ADMIN")),
      )
      .join("\n");

    expect(comment).toContain("STARTUP ONLY");
    expect(comment).toMatch(/drops both/);
    expect(comment).toMatch(/refuses to start/);
    // Only these two are startup-only; the supervisor's own list is the one every job holds.
    expect(CREATED_WITH).toEqual([...(runnerDynamic().cap_add ?? [])].sort());
  });

  // #197-T04 #244-T13
  it("keeps the capability list of the privileged suite equal to the file", () => {
    // The suite runs as root with exactly these capabilities (tests/privileged/conftest.py checks
    // the effective, permitted and bounding sets), so what it proves is what the container is
    // created with; its job phase then drops the startup-only two, as the runner does.
    const bounding = /--bounding-set=-all((?:,\+[a-z_]+)+)/.exec(
      privilegedScript,
    );
    expect(bounding, "no --bounding-set in the script").not.toBeNull();
    const names = (bounding?.[1] ?? "")
      .split(",")
      .filter((name) => name !== "")
      .map((name) => name.slice(1).toUpperCase())
      .sort();

    expect(names).toEqual(CREATED_WITH);
    expect(privilegedScript).toContain("--no-new-privs");
    expect(privilegedScript).toContain("unshare --net --mount");
    // The container mounts nothing from the host, so the suite starts without the host's /run (a
    // tmpfs of its own, with the options of the compose file: the next test).
    expect(privilegedScript).toContain("scripts/privileged_phases.sh");
  });

  // #244-T13
  it("runs the privileged suite in two phases: startup with the startup-only capabilities, then as a job", () => {
    expect(phasesScript).toContain(
      "PRIVILEGED_PHASE=startup uv run --no-sync --offline pytest",
    );
    expect(phasesScript).toContain("tests/privileged/startup");
    // The job phase starts through the production startup step, which drops NET_ADMIN and SETPCAP.
    expect(phasesScript).toContain(
      "PRIVILEGED_PHASE=job uv run --no-sync --offline python tests/privileged/job_phase.py",
    );
  });

  // #244-T12 #249-T03
  it("mounts nothing and shares nothing with the host or another container", () => {
    const service = runnerDynamic();
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    // The nft rules cover TCP, UDP and IPv6 of the engine user, not AF_UNIX. A unix socket cannot
    // leave the container, so the gap is empty exactly as long as nothing is mounted (a Docker
    // socket, a credential helper's socket) and no namespace is shared with a process that listens
    // on one. The three tmpfs of the read-only root filesystem (next test) are private to the
    // container and hold nothing from outside; they are the only mounts, pinned exactly.
    for (const key of [
      "volumes",
      "volumes_from",
      "devices",
      "network_mode",
      "pid",
      "ipc",
      "uts",
      "cgroup",
      "privileged",
      // Keys that change the namespaces or bring files and settings in from elsewhere:
      "userns_mode",
      "sysctls",
      "configs",
      "secrets",
      // `extends` could import any of the keys above from another file, past this list.
      "extends",
    ]) {
      expect(service, key).not.toHaveProperty(key);
    }
    for (const key of ["volumes", "configs", "secrets", "include"]) {
      expect(dynamic, key).not.toHaveProperty(key);
    }
    expect(code).not.toMatch(/docker\.sock/);
    expect(code).not.toMatch(/\/var\/run|\/run\//);
    expect(code).not.toMatch(/^\s*volumes:/m);
  });

  // #249-T03
  it("makes the root filesystem read-only and lists exactly three private tmpfs as the only writable paths", () => {
    const service = runnerDynamic();

    expect(service.read_only).toBe(true);
    expect([...(service.tmpfs ?? [])].sort()).toEqual(READ_ONLY_TMPFS);
    for (const entry of service.tmpfs ?? []) {
      const { path, options: flags } = splitTmpfs(entry);
      // None may run code, honour a setuid bit or file capability, or hold a device node.
      for (const flag of ["rw", "noexec", "nosuid", "nodev"]) {
        expect(flags, `${path} ${flag}`).toContain(flag);
      }
      for (const flag of ["exec", "suid", "dev", "ro"]) {
        expect(flags, `${path} ${flag}`).not.toContain(flag);
      }
      const size = flags.find((flag) => flag.startsWith("size="));
      expect(size, `${path} has a size limit`).toBeDefined();
      // A tmpfs is charged to the memory limit, so none may reach it.
      expect(bytes((size ?? "").slice("size=".length))).toBeLessThan(
        bytes(defaultOf(service.mem_limit)),
      );
    }
    // The engine user (10101) must gain no write path from them: only /tmp, which is world-writable
    // in the image as well, may be writable by others; every other one is owned by root or by the
    // Diff job user and closed to everyone else.
    const worldWritable = (service.tmpfs ?? [])
      .filter((entry) => {
        const mode = /mode=([0-7]+)/.exec(entry)?.[1] ?? "1777";
        return (Number.parseInt(mode, 8) & 0o002) !== 0;
      })
      .map((entry) => entry.split(":")[0]);
    expect(worldWritable).toEqual(["/tmp"]);
    expect(source).not.toMatch(/uid=10101|gid=10101/);
  });

  // #249-T01 #249-T03
  it("runs the privileged suite on the same layout: read-only disk filesystems, the same tmpfs options", () => {
    // The suite proves the container's behaviour, so it runs on its layout: every disk filesystem
    // read-only, and a tmpfs with the compose file's options on the paths the runner writes. (The
    // home directory of the Diff job user is the CI host's own, so it is not modelled.)
    expect(privilegedScript).toMatch(/remount,bind,ro/);
    for (const entry of READ_ONLY_TMPFS) {
      const { path, options } = splitTmpfs(entry);
      if (path === "/home/runner") continue;
      const own = options.filter((flag) => !/^(uid|gid)=/.test(flag)).join(",");
      expect(privilegedScript, path).toContain(
        `mount -t tmpfs -o ${own} tmpfs ${path}`,
      );
    }
    // The execve phase (#250) judges the bounding set, so it must not run under no-new-privileges.
    const execve = privilegedScript
      .split("\n")
      .filter((line) => line.includes("execve_phase.py"));
    expect(execve).toHaveLength(1);
    expect(privilegedScript).toMatch(
      /setpriv \\\n\s+--bounding-set=-all[^\n]*\\\n\s+--inh-caps=-all \\\n\s+uv run --no-sync --offline python tests\/privileged\/execve_phase\.py/,
    );
  });

  // #249-T03
  it("runs the smoke test of the image with the same read-only root filesystem and tmpfs", () => {
    const flags = [...smokeScript.matchAll(/--tmpfs "([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(smokeScript).toContain("--read-only");
    expect([...flags].sort()).toEqual(READ_ONLY_TMPFS);
  });

  // #197-T04
  it("drops Diff jobs to the unprivileged job user and sets the home the root loop does not have", () => {
    const environment = runnerDynamic().environment ?? {};

    expect(environment.RUNNER_DIFF_JOB_USER).toBe("10001:10001");
    expect(environment.HOME).toBe("/home/runner");
  });

  // #202-T08
  it("is wired like the runner: no port, the app over the Docker network, the same stop grace", () => {
    const service = runnerDynamic();
    const runner = plain.services.runner;

    expect(service).not.toHaveProperty("ports");
    expect(service.depends_on?.app?.condition).toBe("service_healthy");
    expect(service.environment?.RUNNER_API_URL).toBe("http://app:3000");
    expect(service.environment?.RUNNER_TOKEN).toBe(
      runner?.environment?.RUNNER_TOKEN,
    );
    expect(service.restart).toBe("unless-stopped");
    expect(service.stop_grace_period).toBe(runner?.stop_grace_period);
    expect(service).not.toHaveProperty("entrypoint");
    expect(service).not.toHaveProperty("command");
  });

  // #202-T08
  it("does not advertise the engine: it passes only the operator's model descriptor, empty by default", () => {
    const environment = runnerDynamic().environment ?? {};

    expect(environment.RUNNER_DYNAMIC_CAPABILITIES).toBe(
      "${RUNNER_DYNAMIC_CAPABILITIES:-}",
    );
    // The checkout and the node directory belong to the per-job preparation, not to deployment.
    expect(Object.keys(environment)).not.toContain("RUNNER_DYNAMIC_CHECKOUT");
    expect(Object.keys(environment)).not.toContain("RUNNER_DYNAMIC_NODE_BIN");
    // The engine command and the advertised engines are decided by the runner's startup self-check
    // and handed to its job processes; nothing in deployment configuration can set them.
    expect(Object.keys(environment)).not.toContain("RUNNER_OPENCODE_COMMAND");
    expect(Object.keys(environment)).not.toContain("RUNNER_ADVERTISED_ENGINES");
    expect(Object.keys(environment)).not.toContain("RUNNER_DYNAMIC_RIPGREP");
  });

  // #202-T08
  it("writes no secret into the file, only a reference to the runner token", () => {
    const environment = runnerDynamic().environment ?? {};

    for (const [key, value] of Object.entries(environment)) {
      if (!/SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD/.test(key)) continue;
      expect(String(value), key).toMatch(/^\$\{[A-Z0-9_]+:\?[^}]*\}$/);
    }
    expect(source).not.toContain("PR_AGENT_COMMAND");
  });

  // #202-T08
  it("says in its first lines that it is opt-in and that the gate is a separate, default-off switch", () => {
    const header = source.split("\n").slice(0, 20).join("\n");

    expect(header).toMatch(/opt-in/i);
    expect(header).toContain("docs/dynamic-review.md");
    expect(header).toMatch(/gate/i);
    // The statements of the first slice no longer hold: the engine is in the image.
    expect(header).not.toMatch(/not (yet )?activatable|cannot be activated/i);
    expect(header).not.toMatch(/engine is not in the (runner )?image/i);
  });
});

describe("compose.coolify.dynamic.yml", () => {
  // #202-T07: Coolify takes one Compose file per resource, so the Dynamic runner of a Coolify
  // installation is a second resource built from this standalone file. It must stay the same runner.
  const coolify = parse(read("compose.coolify.dynamic.yml")) as Compose;
  const coolifySource = read("compose.coolify.dynamic.yml");

  it("adds exactly the one service and nothing else", () => {
    expect(Object.keys(coolify.services)).toEqual(["runner-dynamic"]);
    expect(coolify).not.toHaveProperty("volumes");
    expect(read("compose.coolify.yml")).not.toContain("runner-dynamic");
  });

  it("is the service of compose.dynamic.yml, except that it reaches the app by its address and builds without a local tag", () => {
    const own = { ...(coolify.services["runner-dynamic"] ?? {}) };
    const shared = { ...runnerDynamic() };

    // What differs on purpose: no sibling `app` service to wait for, the address of the app, and the
    // image name (Coolify names the images it builds).
    for (const service of [own, shared]) {
      delete service.depends_on;
      delete service.image;
      service.environment = {
        ...service.environment,
        RUNNER_API_URL: "<differs>",
      };
    }
    expect(own).toEqual(shared);
  });

  it("takes the address of the app from a required variable, not from a sibling service", () => {
    const environment = coolify.services["runner-dynamic"]?.environment ?? {};

    expect(environment.RUNNER_API_URL).toMatch(
      /^\$\{RUNNER_API_URL:\?[^}]*\}$/,
    );
    expect(coolify.services["runner-dynamic"]).not.toHaveProperty("depends_on");
    expect(environment.RUNNER_TOKEN).toBe(
      runnerDynamic().environment?.RUNNER_TOKEN,
    );
  });

  it("says that it is untested on Coolify and points to the guide", () => {
    const header = coolifySource.split("\n").slice(0, 20).join("\n");

    expect(header).toMatch(/not (yet )?(been )?(tested|verified)/i);
    expect(header).toContain("docs/deployment-coolify.md");
    expect(coolifySource).not.toContain("PR_AGENT_COMMAND");
  });
});
