// SPDX-License-Identifier: Apache-2.0

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
  build?: { context?: string; dockerfile?: string; target?: string };
  container_name?: string;
  restart?: string;
  ports?: string[];
  expose?: string[];
  volumes?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: Record<string, unknown>;
  entrypoint?: string[];
  command?: string[] | string;
  stop_grace_period?: string;
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
  // CR-39-T02 #264-T01
  it("defines exactly the services app, runner and runner-dynamic", () => {
    expect(Object.keys(coolify.services).sort()).toEqual([
      "app",
      "runner",
      "runner-dynamic",
    ]);
  });

  // CR-39-T02
  // #118-T03 (the context is the repository root, so the images carry the license files)
  // #264-T03 (the Dynamic runner is the `dynamic` target of the runner Dockerfile)
  it("builds every image from the checkout instead of pulling them, with the Dockerfile of each folder", () => {
    const folders = {
      app: "app",
      runner: "runner",
      "runner-dynamic": "runner",
    } as const;
    for (const [name, folder] of Object.entries(folders)) {
      const definition = service(coolify, name);

      expect(definition.build?.context, name).toBe(".");
      expect(definition.build?.dockerfile, name).toBe(`${folder}/Dockerfile`);
      expect(definition.image, name).toBeUndefined();
      expect(statSync(`${repoRoot}${folder}/Dockerfile`).isFile()).toBe(true);
    }
    expect(service(coolify, "runner").build?.target).toBeUndefined();
    expect(service(coolify, "runner-dynamic").build?.target).toBe("dynamic");
    expect(JSON.stringify(coolify)).not.toContain("ghcr.io");
  });

  // CR-39-T04
  it("publishes no host port at all, so the proxy is the only way in", () => {
    for (const [name, definition] of Object.entries(coolify.services))
      expect(definition, name).not.toHaveProperty("ports");
    expect(service(coolify, "runner")).not.toHaveProperty("expose");
    expect(service(coolify, "runner-dynamic")).not.toHaveProperty("expose");
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
  it("restarts every service after a crash or a reboot unless it was stopped on purpose", () => {
    for (const name of Object.keys(coolify.services))
      expect(service(coolify, name).restart, name).toBe("unless-stopped");
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
    expect(runner.environment?.RUNNER_API_URL).toBe("http://app:3000");
  });

  // CR-39-T12
  it("limits the memory of the runner to the 2 GiB its number of parallel reviews is calculated for, as compose.yml does", () => {
    // Overridable (RUNNER_MEMORY_LIMIT) because the tracked file cannot be edited on Coolify; the
    // default is the 2 GiB the default concurrency is calculated for.
    expect(service(coolify, "runner").mem_limit).toBe(
      "${RUNNER_MEMORY_LIMIT:-2g}",
    );
    expect(service(plain, "runner").mem_limit).toBe(
      "${RUNNER_MEMORY_LIMIT:-2g}",
    );
    expect(service(coolify, "app")).not.toHaveProperty("mem_limit");
  });

  // CR-51-T01
  it("runs the job loop of the runner image, with no entry point or command of its own", () => {
    const runner = service(coolify, "runner");

    expect(runner).not.toHaveProperty("entrypoint");
    expect(runner).not.toHaveProperty("command");
    expect(coolifySource).not.toMatch(/placeholder/i);
  });

  // CR-51-T04
  it("leaves the runner 90 seconds to stop, as compose.yml does", () => {
    expect(service(coolify, "runner").stop_grace_period).toBe("90s");
    expect(service(plain, "runner").stop_grace_period).toBe("90s");
  });

  // CR-51-T02
  it("is compose.yml except for the documented differences: where the images come from, the published port, the address, the project name and the Dynamic runner", () => {
    const rest = (compose: Compose): unknown => {
      const copy = JSON.parse(JSON.stringify(compose)) as Compose & {
        name?: string;
      };
      // Coolify names the project itself.
      delete copy.name;
      // The opt-in Dynamic runner is only in the Coolify file (#264); it is pinned to
      // compose.dynamic.yml in compose-dynamic.test.ts.
      delete copy.services["runner-dynamic"];
      for (const definition of Object.values(copy.services)) {
        delete definition.image;
        delete definition.build;
        delete definition.ports;
        delete definition.expose;
      }
      const environment = copy.services.app?.environment;
      if (environment) delete environment[DIFFERS];
      for (const definition of Object.values(copy.services))
        definition.environment = normalized(definition.environment);
      return copy;
    };

    expect(rest(coolify)).toEqual(rest(plain));
  });

  // CR-51-T05
  it("does not know PR_AGENT_COMMAND, which would send the credentials of every job to another command", () => {
    expect(coolifySource).not.toContain("PR_AGENT_COMMAND");
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

    // Only what Coolify must refuse to deploy without. The master key is checked by the app (it
    // accepts the deprecated BETTER_AUTH_SECRET in its place), and GitHub is optional.
    expect(required).toEqual(["BETTER_AUTH_URL", "RUNNER_TOKEN"].sort());
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
