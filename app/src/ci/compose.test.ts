// SPDX-License-Identifier: Apache-2.0

// Pins down the Docker Compose setup (compose.yml, compose.build.yml, .env.example) as files: which
// services exist and how they are wired, that no secret is written in the compose file, and that
// .env.example documents every variable the stack and the code read. Whether the stack really
// starts, becomes healthy, keeps its data and recovers is proven by docker/smoke/compose.sh, which
// CI runs against freshly built images.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

type Service = {
  image?: string;
  build?: { context?: string; dockerfile?: string };
  restart?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: {
    test?: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  entrypoint?: string[];
  command?: string[] | string;
  stop_grace_period?: string;
  mem_limit?: string;
};
type Compose = {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
};

const composeSource = read("compose.yml");
const compose = parse(composeSource) as Compose;
const buildOverride = parse(read("compose.build.yml")) as Compose;
const envExample = read(".env.example");

function service(name: string): Service {
  const found = compose.services[name];
  if (!found) throw new Error(`compose.yml has no service "${name}"`);
  return found;
}

const SECRET_NAME = /SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD/;

describe("compose services", () => {
  // CR-37-T01
  it("defines exactly the services app and runner", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["app", "runner"]);
  });

  // CR-37-T02
  it("publishes port 3000 of the app and keeps its data in a named volume on /data", () => {
    const app = service("app");

    expect(app.ports?.some((port) => port.endsWith(":3000"))).toBe(true);
    expect(app.volumes).toContain("data:/data");
    expect(Object.keys(compose.volumes ?? {})).toContain("data");
  });

  // CR-40-T04
  it("keeps the backups in a named volume of their own on /backups, apart from /data", () => {
    const app = service("app");

    expect(app.volumes).toContain("backups:/backups");
    expect(Object.keys(compose.volumes ?? {})).toContain("backups");
    expect(app.volumes?.some((volume) => volume.endsWith(":/data"))).toBe(true);
    expect(
      app.volumes?.filter((volume) => volume.split(":")[0] === "data"),
    ).toEqual(["data:/data"]);
  });

  // CR-40-T14
  it("lets the operator choose the time of the daily backup without writing it into the file", () => {
    expect(service("app").environment?.BACKUP_TIME).toBe("${BACKUP_TIME:-}");
  });

  // CR-37-T02
  it("publishes the app on loopback unless an address is chosen on purpose", () => {
    const ports = service("app").ports ?? [];

    expect(ports).toHaveLength(1);
    expect(ports[0]?.startsWith("${APP_BIND_ADDRESS:-127.0.0.1}:")).toBe(true);
  });

  // CR-37-T02
  it("gives the runner no published port and points it at the app over the compose network", () => {
    const runner = service("runner");

    expect(runner).not.toHaveProperty("ports");
    expect(runner.environment?.RUNNER_API_URL).toBe("http://app:3000");
    expect(runner.environment).not.toHaveProperty("APP_URL");
  });

  // CR-37-T03
  it("gives the app a Node based health check with interval, timeout and retries", () => {
    const check = service("app").healthcheck;

    expect(check?.interval).toBeTruthy();
    expect(check?.timeout).toBeTruthy();
    expect(check?.retries).toBeGreaterThan(0);
    expect(check?.start_period).toBeTruthy();
    expect(check?.test?.slice(0, 2)).toEqual(["CMD", "node"]);
    expect(check?.test?.join(" ")).toContain("/api/health");
    expect(check?.test?.join(" ")).not.toMatch(/curl|wget/);
  });

  // CR-37-T03
  it("starts the runner only when the app is healthy", () => {
    expect(service("runner").depends_on?.app?.condition).toBe(
      "service_healthy",
    );
  });

  it("restarts both services unless they were stopped on purpose", () => {
    expect(service("app").restart).toBe("unless-stopped");
    expect(service("runner").restart).toBe("unless-stopped");
  });

  it("defaults to the images that CI publishes to GHCR", () => {
    expect(service("app").image).toContain(
      "ghcr.io/expidetgames/code-reviewer-app:development",
    );
    expect(service("runner").image).toContain(
      "ghcr.io/expidetgames/code-reviewer-runner:development",
    );
  });

  // #118-T03 (the context is the repository root, so the images carry the license files)
  it("builds both images from the checkout, with the Dockerfile of each folder, when the build override is added", () => {
    for (const name of ["app", "runner"] as const) {
      expect(buildOverride.services[name]?.build?.context).toBe(".");
      expect(buildOverride.services[name]?.build?.dockerfile).toBe(
        `${name}/Dockerfile`,
      );
    }
    expect(statSync(`${repoRoot}app/Dockerfile`).isFile()).toBe(true);
    expect(statSync(`${repoRoot}runner/Dockerfile`).isFile()).toBe(true);
  });

  // CR-51-T01
  it("runs the job loop of the runner image: no entry point and no command of its own", () => {
    const runner = service("runner");

    expect(runner).not.toHaveProperty("entrypoint");
    expect(runner).not.toHaveProperty("command");
    expect(composeSource).not.toMatch(/placeholder/i);
  });

  // CR-51-T01
  it("passes the settings of the job loop, with the defaults the loop itself has", () => {
    const loop = readFileSync(
      `${repoRoot}runner/src/code_reviewer_runner/job_loop/settings.py`,
      "utf8",
    );
    const defaultOf = (name: string): number => {
      const match = new RegExp(`^${name} = ([0-9. *]+)$`, "m").exec(loop);
      if (!match) throw new Error(`no default ${name} in settings.py`);
      return (match[1] as string)
        .split("*")
        .map((factor) => Number(factor.trim()))
        .reduce((product, factor) => product * factor, 1);
    };
    const environment = service("runner").environment ?? {};

    expect(environment.RUNNER_CONCURRENCY).toBe(
      `\${RUNNER_CONCURRENCY:-${String(defaultOf("DEFAULT_CONCURRENCY"))}}`,
    );
    expect(environment.RUNNER_JOB_TIMEOUT_SECONDS).toBe(
      `\${RUNNER_JOB_TIMEOUT_SECONDS:-${String(defaultOf("DEFAULT_JOB_TIMEOUT_SECONDS"))}}`,
    );
    expect(environment.RUNNER_POLL_INTERVAL_SECONDS).toBe(
      `\${RUNNER_POLL_INTERVAL_SECONDS:-${String(defaultOf("DEFAULT_POLL_INTERVAL_SECONDS"))}}`,
    );
    expect(environment.RUNNER_ID).toBe("${RUNNER_ID:-}");
  });

  // CR-51-T04
  it("leaves the runner 90 seconds to stop: its shutdown grace period of 60 s plus the report", () => {
    expect(service("runner").stop_grace_period).toBe("90s");
    expect(service("app")).not.toHaveProperty("stop_grace_period");
  });

  // CR-51-T04
  it("does not pass the shutdown grace period on, so it cannot outgrow the 90 seconds", () => {
    expect(service("runner").environment).not.toHaveProperty(
      "RUNNER_SHUTDOWN_GRACE_SECONDS",
    );
  });
});

// The compose files an operator uses. The one smoke test file that sets PR_AGENT_COMMAND lives in
// docker/smoke and is never part of a deployment.
const SHIPPED_COMPOSE_FILES = readdirSync(repoRoot).filter((name) =>
  /^compose(\..+)?\.ya?ml$/.test(name),
);

describe("compose files and the test command of the runner", () => {
  it("finds the six compose files of the repository", () => {
    expect(SHIPPED_COMPOSE_FILES.sort()).toEqual([
      "compose.build.yml",
      "compose.coolify.dynamic.yml",
      "compose.coolify.yml",
      "compose.dynamic.yml",
      "compose.large.yml",
      "compose.yml",
    ]);
  });

  // CR-51-T05
  it("sets PR_AGENT_COMMAND in no compose file that is shipped, not even in a comment", () => {
    for (const file of SHIPPED_COMPOSE_FILES)
      expect(read(file), file).not.toContain("PR_AGENT_COMMAND");
  });

  // CR-51-T05
  it("sets it only in the override file of the compose smoke test, which stays under docker/smoke", () => {
    const override = parse(
      read("docker/smoke/compose.fake-job.yml"),
    ) as Compose;

    expect(
      override.services.runner?.environment?.PR_AGENT_COMMAND,
    ).toBeTruthy();
    expect(SHIPPED_COMPOSE_FILES).not.toContain("compose.fake-job.yml");
  });
});

describe("compose secrets", () => {
  // CR-37-T09
  it("hands the runner token to app and runner from the same variable", () => {
    const fromApp = service("app").environment?.RUNNER_TOKEN;
    const fromRunner = service("runner").environment?.RUNNER_TOKEN;

    expect(fromApp).toMatch(/^\$\{RUNNER_TOKEN:\?/);
    expect(fromRunner).toBe(fromApp);
  });

  // CR-37-T09
  it("writes no secret into the compose files, only references to variables without a default", () => {
    for (const [name, definition] of Object.entries(compose.services)) {
      for (const [key, value] of Object.entries(definition.environment ?? {})) {
        if (!SECRET_NAME.test(key)) continue;
        const reference = new RegExp(`^\\$\\{${key}(:\\?[^}]*|:-)\\}$`);
        expect(String(value), `${name} ${key}`).toMatch(reference);
      }
    }
    expect(composeSource).not.toMatch(/-----BEGIN/);
  });

  // CR-37-T08
  it("stops before creating any container when the runner token is empty", () => {
    expect(service("app").environment?.RUNNER_TOKEN).toContain(
      "${RUNNER_TOKEN:?",
    );
    expect(service("runner").environment?.RUNNER_TOKEN).toContain(
      "${RUNNER_TOKEN:?",
    );
  });

  // #97-SU-17
  it("leaves the master key to the app, which names APP_SECRET when it is missing, and passes the deprecated name on", () => {
    // Required by the app, not by compose: an existing installation updates with the .env it has
    // (BETTER_AUTH_SECRET), and the app accepts that name in place of APP_SECRET.
    expect(service("app").environment?.APP_SECRET).toBe("${APP_SECRET:-}");
    expect(service("app").environment?.BETTER_AUTH_SECRET).toBe(
      "${BETTER_AUTH_SECRET:-}",
    );
  });

  // #97-SU-17
  it("requires no GitHub setting: the stack starts without any, and GitHub is then not configured", () => {
    const environment = service("app").environment ?? {};
    const github = Object.keys(environment).filter((key) =>
      key.startsWith("GITHUB_"),
    );

    expect(github.length).toBeGreaterThan(0);
    for (const key of github)
      expect(environment[key], key).toBe(`\${${key}:-}`);
  });
});

// ---- the variables of the previous release (the update imports them once) ----

const LEGACY_IMPORTED = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "ALLOWED_GITHUB_LOGINS",
  "ALLOWED_GITHUB_ORG",
  "LLM_PROVIDER",
  "LLM_API_KEY",
] as const;

/** The comment block above `NAME=` (or `# NAME=`) in .env.example, up to the blank line before it. */
function commentOf(name: string): string {
  const lines = envExample.split("\n");
  const index = lines.findIndex((line) =>
    new RegExp(`^#?\\s?${name}=`).test(line),
  );
  if (index < 0) throw new Error(`.env.example does not document ${name}`);
  const comment: string[] = [];
  for (let i = index - 1; i >= 0 && (lines[i] ?? "").startsWith("#"); i -= 1)
    comment.unshift(lines[i] ?? "");
  // A block that documents several variables shares the comment above its first line.
  return comment.map((line) => line.replace(/^#\s?/, "")).join(" ");
}

describe("the update from a version before accounts", () => {
  // #106-IM-21
  it("requires no GitHub, LLM or sign-in setting in any compose file: they are passed on empty", () => {
    for (const file of ["compose.yml", "compose.coolify.yml"]) {
      const app = (parse(read(file)) as Compose).services.app;
      for (const [key, value] of Object.entries(app?.environment ?? {})) {
        if (!/^(GITHUB_|LLM_|ALLOWED_)/.test(key)) continue;
        expect(String(value), `${file} ${key}`).not.toContain(":?");
      }
    }
  });

  // #106-IM-21
  it("passes the master key under both names and leaves it to the app, which refuses to start without one", () => {
    for (const file of ["compose.yml", "compose.coolify.yml"]) {
      const app = (parse(read(file)) as Compose).services.app;
      expect(app?.environment?.APP_SECRET, file).toBe("${APP_SECRET:-}");
      expect(app?.environment?.BETTER_AUTH_SECRET, file).toBe(
        "${BETTER_AUTH_SECRET:-}",
      );
    }
    expect(envExample).toMatch(/^APP_SECRET=$/m);
    expect(commentOf("APP_SECRET")).toMatch(/Required/);
    expect(commentOf("APP_SECRET")).toMatch(/refuses to start without it/);
  });

  // #106-IM-21
  it.each(LEGACY_IMPORTED)(
    "says in .env.example that %s is imported once and ignored afterwards",
    (name) => {
      // The comment above the variable, or the introduction of its section, says "imports ... once".
      const section = envExample.slice(
        0,
        envExample.search(new RegExp(`^#?\\s?${name}=`, "m")),
      );
      const nearby = `${commentOf(name)}\n${section.slice(-2600)}`;

      expect(nearby).toMatch(/\bonce\b/i);
    },
  );

  // #106-IM-21
  it("marks the GitHub OAuth app variables as no longer used", () => {
    for (const name of [
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
    ]) {
      expect(envExample).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    expect(commentOf("GITHUB_OAUTH_CLIENT_ID")).toMatch(/No longer used/);
    expect(commentOf("GITHUB_OAUTH_CLIENT_ID")).toMatch(/not\s+imported/);
  });

  // #106-IM-21
  it("tells an installation to add APP_SECRET with the same value as BETTER_AUTH_SECRET", () => {
    expect(commentOf("BETTER_AUTH_SECRET")).toMatch(/SAME value/);
  });
});

// ---- .env.example against compose.yml and the code ----

// Variables that the code reads but an operator never sets: the runtime or the image provides them.
const PROVIDED_BY_RUNTIME = new Set([
  "NODE_ENV", // Next.js and the image
  "NEXT_RUNTIME", // Next.js
  "DATABASE_PATH", // the image fixes it to /data/app.db, the path of the volume
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) {
      return ["node_modules", ".venv", "__pycache__", "test-support"].includes(
        entry,
      )
        ? []
        : sourceFiles(path);
    }
    return [path];
  });
}

function variablesRead(): Set<string> {
  const names = new Set<string>();
  const add = (source: string, pattern: RegExp): void => {
    for (const match of source.matchAll(pattern)) names.add(match[1] ?? "");
  };
  for (const file of sourceFiles(`${repoRoot}app/src`)) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    add(source, /\benv\.([A-Z][A-Z0-9_]+)/g);
    add(source, /\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g);
    // Helpers that take the environment first and the variable name second.
    add(source, /\(\s*env,\s*"([A-Z][A-Z0-9_]+)"/g);
    // A switch whose name is kept in a constant ending in _FLAG and read as env[CONSTANT].
    add(source, /\bconst [A-Z][A-Z0-9_]*_FLAG\s*=\s*"([A-Z][A-Z0-9_]+)"/g);
  }
  for (const file of sourceFiles(`${repoRoot}runner/src`)) {
    if (!file.endsWith(".py")) continue;
    const source = readFileSync(file, "utf8");
    add(
      source,
      /(?:environ(?:\.get)?\s*[[(]|getenv\()\s*["']([A-Z][A-Z0-9_]+)["']/g,
    );
    // The job loop (job_loop/settings.py) reads from a mapping it is given, called `environment`.
    add(source, /\benvironment\.get\(\s*["']([A-Z][A-Z0-9_]+)["']/g);
    add(source, /\(\s*environment,\s*["']([A-Z][A-Z0-9_]+)["']/g);
  }
  for (const name of PROVIDED_BY_RUNTIME) names.delete(name);
  return names;
}

function composeReferences(): Set<string> {
  const names = new Set<string>();
  for (const file of [
    "compose.yml",
    "compose.build.yml",
    "compose.dynamic.yml",
  ]) {
    for (const match of read(file).matchAll(/\$\{([A-Z][A-Z0-9_]*)/g))
      names.add(match[1] ?? "");
  }
  return names;
}

/** Variable name -> its value (`NAME=value`, or the commented example `# NAME=value`) and whether its block explains it. */
function documented(): Map<string, { value: string; explained: boolean }> {
  const result = new Map<string, { value: string; explained: boolean }>();
  const assignment = /^#?\s?([A-Z][A-Z0-9_]*)=(.*)$/;
  for (const block of envExample.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const explained = lines.some(
      (line) => line.startsWith("#") && !assignment.test(line),
    );
    for (const line of lines) {
      const match = assignment.exec(line);
      if (match) {
        result.set(match[1] ?? "", { value: match[2] ?? "", explained });
      }
    }
    // `# NAME: what the compose files do with it`: a variable the code reads that is not a setting
    // (the compose files fix it or only the test stack sets it). It is written without an equals
    // sign so that nobody takes it for a line to uncomment.
    for (const line of lines) {
      const note = /^# ([A-Z][A-Z0-9_]*): \S/.exec(line);
      if (note) result.set(note[1] ?? "", { value: "", explained: true });
    }
  }
  return result;
}

describe(".env.example", () => {
  // CR-37-T10
  it("documents every variable that compose.yml references or the app and runner read in code", () => {
    const wanted = new Set([...composeReferences(), ...variablesRead()]);
    const present = documented();

    const undocumented = [...wanted].filter((name) => !present.has(name));
    const uncommented = [...wanted].filter(
      (name) => present.has(name) && !present.get(name)?.explained,
    );

    expect(undocumented).toEqual([]);
    expect(uncommented).toEqual([]);
  });

  // CR-37-T10
  it("lists no variable that neither compose.yml nor the code reads", () => {
    const wanted = new Set([...composeReferences(), ...variablesRead()]);

    expect(
      [...documented().keys()].filter((name) => !wanted.has(name)),
    ).toEqual([]);
  });

  // CR-37-T11
  it("holds no value for a secret and no key material", () => {
    for (const [name, { value }] of documented()) {
      if (SECRET_NAME.test(name)) expect(value, name).toBe("");
      expect(value, name).not.toMatch(/BEGIN [A-Z ]*KEY|ghp_|github_pat_|sk-/);
    }
    // The private key's format is explained with a placeholder, not an example key.
    expect(envExample).not.toMatch(
      /-----BEGIN [A-Z ]*KEY-----\\n[A-Za-z0-9+/]/,
    );
  });

  // CR-37-T11
  it("is the only environment file that git tracks", () => {
    const ignore = read(".gitignore")
      .split("\n")
      .map((line) => line.trim());

    expect(ignore).toContain(".env*");
    expect(ignore).toContain("!.env.example");
  });
});
