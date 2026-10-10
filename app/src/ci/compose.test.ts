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
    expect(runner.environment?.APP_URL).toBe("http://app:3000");
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

  it("replaces the placeholder entry point of the runner only until the job loop exists", () => {
    // CR-29 removes `entrypoint`; this reminder keeps the placeholder from becoming permanent.
    expect(composeSource).toContain("PLACEHOLDER until the job loop exists");
    expect(service("runner").entrypoint?.[0]).toBe("python");
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
  }
  for (const file of sourceFiles(`${repoRoot}runner/src`)) {
    if (!file.endsWith(".py")) continue;
    add(
      readFileSync(file, "utf8"),
      /(?:environ(?:\.get)?\s*[[(]|getenv\()\s*["']([A-Z][A-Z0-9_]+)["']/g,
    );
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
