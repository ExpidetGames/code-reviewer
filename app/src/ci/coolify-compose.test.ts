// Pins down compose.coolify.yml, the Compose file of the Coolify deployment, as a file: it is built
// from the repository (nothing is pulled from the private GHCR packages), publishes no host port so
// that Coolify's proxy is the only way in, asks for every secret as a required variable, and stays in
// step with compose.yml (the file for one machine), which docker/smoke/compose.sh proves in a real
// stack. Whether Coolify itself accepts the file is checked by hand on the instance (CR-39-T02).
import { readFileSync, statSync } from "node:fs";
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
  container_name?: string;
  restart?: string;
  ports?: string[];
  expose?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: Record<string, unknown>;
  entrypoint?: string[];
  mem_limit?: string;
};
type Compose = {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
};

const coolifySource = read("compose.coolify.yml");
const coolify = parse(coolifySource) as Compose;
const plain = parse(read("compose.yml")) as Compose;
const envExample = read(".env.example");

function service(compose: Compose, name: string): Service {
  const found = compose.services[name];
  if (!found) throw new Error(`no service "${name}"`);
  return found;
}

/** `${NAME:?some message}` and `${NAME:?}` are the same requirement; only the message differs. */
function withoutMessage(value: string): string {
  return value.replace(/:\?[^}]*\}/g, ":?}");
}

function normalized(
  environment: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment ?? {}).map(([key, value]) => [
      key,
      withoutMessage(String(value)),
    ]),
  );
}

// The only setting that is not the same in both files: on one machine it may default to localhost, on
// Coolify it is the public https address and must be entered.
const DIFFERS = "BETTER_AUTH_URL";

describe("compose.coolify.yml services", () => {
  // CR-39-T02
  it("defines exactly the services app and runner", () => {
    expect(Object.keys(coolify.services).sort()).toEqual(["app", "runner"]);
  });

  // CR-39-T02
  it("builds both images from their folders of the checkout instead of pulling them", () => {
    for (const [name, context] of [
      ["app", "app"],
      ["runner", "runner"],
    ] as const) {
      const definition = service(coolify, name);

      expect(definition.build?.context, name).toBe(context);
      expect(definition.image, name).toBeUndefined();
      expect(statSync(`${repoRoot}${context}/Dockerfile`).isFile()).toBe(true);
    }
    expect(JSON.stringify(coolify)).not.toContain("ghcr.io");
  });

  // CR-39-T04
  it("publishes no host port at all, so the proxy is the only way in", () => {
    for (const [name, definition] of Object.entries(coolify.services))
      expect(definition, name).not.toHaveProperty("ports");
    expect(service(coolify, "runner")).not.toHaveProperty("expose");
  });

  // CR-39-T02
  it("exposes port 3000 of the app, the port the domain is routed to", () => {
    expect(service(coolify, "app").expose).toEqual(["3000"]);
  });

  it("sets no fixed container name, which Coolify generates for every deployment", () => {
    for (const [name, definition] of Object.entries(coolify.services))
      expect(definition, name).not.toHaveProperty("container_name");
  });

  // CR-39-T05
  it("keeps the database and the backups in two named volumes, the same as compose.yml", () => {
    const app = service(coolify, "app");

    expect(app.volumes).toEqual(service(plain, "app").volumes);
    expect(app.volumes).toEqual(["data:/data", "backups:/backups"]);
    expect(Object.keys(coolify.volumes ?? {}).sort()).toEqual([
      "backups",
      "data",
    ]);
  });

  // CR-39-T12
  it("restarts both services after a crash or a reboot unless they were stopped on purpose", () => {
    expect(service(coolify, "app").restart).toBe("unless-stopped");
    expect(service(coolify, "runner").restart).toBe("unless-stopped");
  });

  // CR-39-T02
  it("gives the app the same Node based health check as compose.yml, on /api/health", () => {
    const check = service(coolify, "app").healthcheck;

    expect(check).toEqual(service(plain, "app").healthcheck);
    expect(JSON.stringify(check)).toContain("/api/health");
    expect(JSON.stringify(check)).not.toMatch(/curl|wget/);
  });

  // CR-39-T02
  it("starts the runner only when the app is healthy and points it at the app over the Docker network", () => {
    const runner = service(coolify, "runner");

    expect(runner.depends_on?.app?.condition).toBe("service_healthy");
    expect(runner.environment?.APP_URL).toBe("http://app:3000");
  });

  // CR-39-T12
  it("limits the memory of the runner to the 2 GiB its number of parallel reviews is calculated for, as compose.yml does", () => {
    expect(service(coolify, "runner").mem_limit).toBe("2g");
    expect(service(plain, "runner").mem_limit).toBe("2g");
    expect(service(coolify, "app")).not.toHaveProperty("mem_limit");
  });

  it("carries the same runner entry point as compose.yml, so the job loop ticket removes both", () => {
    expect(service(coolify, "runner").entrypoint).toEqual(
      service(plain, "runner").entrypoint,
    );
  });
});

describe("compose.coolify.yml settings", () => {
  // CR-39-T03
  it("passes exactly the settings compose.yml passes, to the app and to the runner", () => {
    for (const name of ["app", "runner"]) {
      expect(
        Object.keys(service(coolify, name).environment ?? {}).sort(),
        name,
      ).toEqual(Object.keys(service(plain, name).environment ?? {}).sort());
    }
  });

  // CR-39-T03
  it("reads every setting the same way as compose.yml, including which ones are required and the defaults", () => {
    for (const name of ["app", "runner"]) {
      const here = normalized(service(coolify, name).environment);
      const there = normalized(service(plain, name).environment);
      delete here[DIFFERS];
      delete there[DIFFERS];

      expect(here, name).toEqual(there);
    }
  });

  // CR-39-T03
  it("requires the public address of the app, with no localhost default", () => {
    expect(service(coolify, "app").environment?.[DIFFERS]).toBe(
      "${BETTER_AUTH_URL:?}",
    );
  });

  // CR-39-T03
  it("marks a required setting in the form Coolify recognizes, without a message", () => {
    const required = Object.entries(service(coolify, "app").environment ?? {})
      .filter(([, value]) => String(value).includes(":?"))
      .map(([key]) => key)
      .sort();

    expect(required).toEqual(
      [
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_SLUG",
        "GITHUB_APP_WEBHOOK_SECRET",
        "GITHUB_OAUTH_CLIENT_ID",
        "GITHUB_OAUTH_CLIENT_SECRET",
        "RUNNER_TOKEN",
      ].sort(),
    );
    for (const key of required)
      expect(service(coolify, "app").environment?.[key]).toBe(`\${${key}:?}`);
    expect(service(coolify, "runner").environment?.RUNNER_TOKEN).toBe(
      "${RUNNER_TOKEN:?}",
    );
  });

  // CR-39-T03
  it("documents every variable it references in .env.example", () => {
    const referenced = new Set(
      [...coolifySource.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(
        (match) => match[1],
      ),
    );
    const documented = new Set(
      [...envExample.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map(
        (match) => match[1],
      ),
    );

    expect(referenced.size).toBeGreaterThan(10);
    expect([...referenced].filter((name) => !documented.has(name))).toEqual([]);
  });

  // CR-39-T11
  it("writes no secret into the file, only references to variables", () => {
    const secret = /SECRET|TOKEN|PRIVATE_KEY|API_KEY|PASSWORD/;
    for (const [name, definition] of Object.entries(coolify.services)) {
      for (const [key, value] of Object.entries(definition.environment ?? {})) {
        if (!secret.test(key)) continue;
        expect(String(value), `${name} ${key}`).toMatch(
          new RegExp(`^\\$\\{${key}(:\\?|:-)\\}$`),
        );
      }
    }
    expect(coolifySource).not.toMatch(/-----BEGIN/);
  });

  it("uses no Coolify generated value for the address, which would go stale when the domain changes", () => {
    expect(coolifySource).not.toMatch(/SERVICE_(URL|FQDN)_/);
  });
});
