// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down compose.large.yml as a file: the services of the large topology (Postgres, several app
// replicas, several runners, a reverse proxy sketch), how they are wired, that no secret is written
// in it, and that the required variables are the ones docs/deployment-large.md lists. Whether the
// stack really starts is the operator's deployment, not an automated test (the small stack's smoke
// test is docker/smoke/compose.sh).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(`${repoRoot}compose.large.yml`, "utf8");

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

type Service = {
  image?: string;
  restart?: string;
  ports?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: { test?: string[] };
  deploy?: { replicas?: number };
  mem_limit?: string;
  stop_grace_period?: string;
  command?: string[] | string;
};
type Compose = {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
};

const compose = parse(source) as Compose;

function service(name: string): Service {
  const found = compose.services[name];
  if (!found) throw new Error(`compose.large.yml has no service "${name}"`);
  return found;
}

/** A value that reads a variable (`${NAME}`, `${NAME:-x}`, `${NAME:?x}`) and holds no secret itself. */
const VARIABLE_REFERENCE = /^\$\{[A-Z_][A-Z0-9_]*(:[?-][^}]*)?\}$/;
const SECRET_NAME = /SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD/;

describe("compose.large.yml services", () => {
  // #105-PG-16
  it("defines Postgres, one app replica for the setup, two runners and a proxy", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "app",
      "postgres",
      "proxy",
      "runner",
    ]);
    // One app replica: the first-run setup is per process (ADR 2.2); the guide scales out afterwards.
    expect(service("app").deploy?.replicas).toBe(1);
    expect(service("runner").deploy?.replicas).toBe(2);
  });

  // #105-PG-16
  it("keeps the database in a named volume and checks it is ready", () => {
    const postgres = service("postgres");

    expect(postgres.volumes).toContain("postgres:/var/lib/postgresql/data");
    expect(Object.keys(compose.volumes ?? {})).toContain("postgres");
    expect(postgres.healthcheck?.test?.join(" ")).toContain("pg_isready");
  });

  // #105-PG-16
  it("points the app at Postgres through DATABASE_URL built from the Postgres variables", () => {
    const url = service("app").environment?.DATABASE_URL ?? "";

    expect(url).toContain("postgres://");
    expect(url).toContain("${POSTGRES_PASSWORD:?");
    expect(url).toContain("@postgres:5432/");
  });

  // #105-PG-16
  it("starts the app after a healthy database and the runners after a healthy app", () => {
    expect(service("app").depends_on?.postgres?.condition).toBe(
      "service_healthy",
    );
    expect(service("runner").depends_on?.app?.condition).toBe(
      "service_healthy",
    );
  });

  // #105-PG-16
  it("publishes no port on the app or the runners and puts the proxy in front", () => {
    expect(service("app")).not.toHaveProperty("ports");
    expect(service("runner")).not.toHaveProperty("ports");
    expect(service("proxy").ports?.some((port) => port.endsWith(":80"))).toBe(
      true,
    );
    expect(service("proxy").depends_on?.app?.condition).toBe("service_healthy");
  });

  // #105-PG-16
  it("passes the daily backup settings to no service: the operator backs up Postgres", () => {
    for (const [name, definition] of Object.entries(compose.services)) {
      const environment = definition.environment ?? {};
      expect(environment, name).not.toHaveProperty("BACKUP_TIME");
      expect(environment, name).not.toHaveProperty("BACKUP_DIR");
    }
  });
});

describe("compose.large.yml secrets and required variables", () => {
  // #105-PG-16
  it("writes no secret value, only references to variables", () => {
    for (const [name, definition] of Object.entries(compose.services)) {
      for (const [key, value] of Object.entries(definition.environment ?? {})) {
        if (!SECRET_NAME.test(key)) continue;
        expect(String(value), `${name} ${key}`).toMatch(VARIABLE_REFERENCE);
      }
    }
    expect(source).not.toMatch(/-----BEGIN/);
  });

  // #105-PG-16
  it("requires the master key, the runner token, the public address and the database password", () => {
    expect(service("app").environment?.APP_SECRET).toContain("${APP_SECRET:?");
    expect(service("app").environment?.BETTER_AUTH_URL).toContain(
      "${BETTER_AUTH_URL:?",
    );
    expect(service("app").environment?.RUNNER_TOKEN).toContain(
      "${RUNNER_TOKEN:?",
    );
    expect(service("postgres").environment?.POSTGRES_PASSWORD).toContain(
      "${POSTGRES_PASSWORD:?",
    );
  });

  // #105-PG-16
  it("ships the default proxy config it mounts, forwarding to the app", () => {
    expect(existsSync(`${repoRoot}docker/proxy/default.conf`)).toBe(true);
    expect(read("docker/proxy/default.conf")).toContain("app:3000");
  });

  // #105-PG-16
  it("sets the test command of the runner in no large compose file", () => {
    expect(source).not.toContain("PR_AGENT_COMMAND");
  });
});
