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
  build?: { context?: string };
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

  it("builds both images from their folders when the build override is added", () => {
    expect(buildOverride.services.app?.build?.context).toBe("app");
    expect(buildOverride.services.runner?.build?.context).toBe("runner");
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
  it("finds the three compose files of the repository", () => {
    expect(SHIPPED_COMPOSE_FILES.sort()).toEqual([
      "compose.build.yml",
      "compose.coolify.yml",
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
  it("stops before creating any container when a required setting is empty", () => {
    for (const key of [
      "BETTER_AUTH_SECRET",
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_WEBHOOK_SECRET",
      "GITHUB_APP_PRIVATE_KEY",
      "RUNNER_TOKEN",
    ]) {
      expect(service("app").environment?.[key], key).toContain(`\${${key}:?`);
    }
    expect(service("runner").environment?.RUNNER_TOKEN).toContain(
      "${RUNNER_TOKEN:?",
    );
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
  for (const file of ["compose.yml", "compose.build.yml"]) {
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
