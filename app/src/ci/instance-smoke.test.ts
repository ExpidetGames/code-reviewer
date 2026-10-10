// Pins down docker/smoke/instance.sh, the smoke test of a running instance (health, login page,
// webhook with a wrong signature, runner API without a token). The script is run for real, as a
// child process, against a small HTTP server in this test that answers what a healthy or a broken
// instance would. Whether a real deployment passes it is checked by running the script against the
// Docker Compose stack (docker/smoke/compose.sh) and, by hand, against the Coolify instance.
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = `${repoRoot}docker/smoke/instance.sh`;

type Answers = Record<string, number>;
type Seen = { method: string; path: string; headers: IncomingHttpHeaders };

/** What a healthy instance answers to the four requests of the script. */
const HEALTHY: Answers = {
  "GET /api/health": 200,
  "GET /login": 200,
  "POST /api/webhooks/github-app": 401,
  "POST /api/runners/v1/claim": 401,
};

const servers: Server[] = [];

async function fakeInstance(
  answers: Answers,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    seen.push({ method: request.method ?? "", path, headers: request.headers });
    request.resume();
    response.statusCode = answers[`${request.method} ${path}`] ?? 404;
    response.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    seen,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function run(
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("bash", [script, ...args], {
      // Nothing of the developer's environment is needed; a proxy setting would even get in the way.
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("the instance smoke test", () => {
  it("is an executable script", () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  // CR-39-T01
  it("passes against an instance that answers as a healthy deployment does", async () => {
    const { url } = await fakeInstance(HEALTHY);

    const result = await run([url]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("smoke test passed");
    expect(result.err).toBe("");
  });

  // CR-39-T01
  it.each([
    ["the health endpoint is down", "GET /api/health", 503, "/api/health"],
    ["the login page fails", "GET /login", 500, "/login"],
    ["the login page only redirects", "GET /login", 302, "/login"],
    [
      "the webhook accepts a wrongly signed delivery",
      "POST /api/webhooks/github-app",
      202,
      "/api/webhooks/github-app",
    ],
    [
      "the webhook answers something else than 401",
      "POST /api/webhooks/github-app",
      500,
      "/api/webhooks/github-app",
    ],
    [
      "the runner endpoint answers a request without a token",
      "POST /api/runners/v1/claim",
      200,
      "/api/runners/v1/claim",
    ],
    [
      "the runner endpoint does not exist",
      "POST /api/runners/v1/claim",
      404,
      "/api/runners/v1/claim",
    ],
  ])(
    "fails with a non-zero exit code and names the check when %s",
    async (_name, key, status, named) => {
      const { url } = await fakeInstance({ ...HEALTHY, [key]: status });

      const result = await run([url]);

      expect(result.code).toBe(1);
      expect(result.err).toContain("FAILED");
      expect(result.err).toContain(named);
      expect(result.err).toContain(`got ${String(status)}`);
      expect(result.out).not.toContain("smoke test passed");
    },
  );

  // CR-39-T01
  it("reports every failing check, not only the first", async () => {
    const { url } = await fakeInstance({
      ...HEALTHY,
      "GET /api/health": 503,
      "POST /api/runners/v1/claim": 200,
    });

    const result = await run([url]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("/api/health");
    expect(result.err).toContain("/api/runners/v1/claim");
    expect(result.err).toContain("2 check(s) failed");
  });

  // CR-39-T01
  it("fails when nothing answers on the address", async () => {
    const { url } = await fakeInstance(HEALTHY);
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );

    const result = await run([url]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("got 000");
  });

  // CR-39-T01
  it("does not follow a redirect to a page that would answer 200", async () => {
    const server = createServer((request, response) => {
      request.resume();
      if (request.url === "/api/health") {
        response.statusCode = 308;
        response.setHeader("location", "/login");
      } else if (request.url === "/login") {
        response.statusCode = 200;
      } else {
        response.statusCode = request.method === "POST" ? 401 : 404;
      }
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;

    const result = await run([`http://127.0.0.1:${String(port)}`]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("GET /api/health: expected 2xx, got 308");
  });

  it("accepts an address with a trailing slash", async () => {
    const { url, seen } = await fakeInstance(HEALTHY);

    const result = await run([`${url}/`]);

    expect(result.code).toBe(0);
    expect(seen.map((entry) => entry.path)).not.toContain("//api/health");
  });

  // CR-39-T01
  it("sends the webhook as an unsigned-looking delivery with a wrong digest and the runner call without any credential", async () => {
    const { url, seen } = await fakeInstance(HEALTHY);

    await run([url]);

    const webhook = seen.find((entry) =>
      entry.path.startsWith("/api/webhooks"),
    );
    const claim = seen.find((entry) => entry.path.startsWith("/api/runners"));
    expect(webhook?.method).toBe("POST");
    expect(webhook?.headers["x-github-event"]).toBe("ping");
    expect(webhook?.headers["x-github-delivery"]).toBeTruthy();
    expect(webhook?.headers["x-hub-signature-256"]).toBe(
      `sha256=${"0".repeat(64)}`,
    );
    expect(claim?.method).toBe("POST");
    expect(claim?.headers.authorization).toBeUndefined();
    expect(seen.every((entry) => entry.headers.cookie === undefined)).toBe(
      true,
    );
  });

  // CR-39-T01
  it("leaves out the runner check only when asked to, says so, and still fails on every other check", async () => {
    const withoutRunnerApi = { ...HEALTHY, "POST /api/runners/v1/claim": 404 };
    const { url, seen } = await fakeInstance(withoutRunnerApi);

    const skipped = await run(["--skip-runner-endpoint", url]);

    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain("skipped POST /api/runners/v1/claim");
    expect(seen.map((entry) => entry.path)).not.toContain(
      "/api/runners/v1/claim",
    );

    const { url: brokenUrl } = await fakeInstance({
      ...withoutRunnerApi,
      "GET /api/health": 503,
    });
    const stillBroken = await run(["--skip-runner-endpoint", brokenUrl]);
    expect(stillBroken.code).toBe(1);

    const withoutFlag = await run([url]);
    expect(withoutFlag.code).toBe(1);
  });

  it.each([
    ["no address", []],
    ["two addresses", ["http://127.0.0.1:1", "http://127.0.0.1:2"]],
    ["an address without a scheme", ["reviews.example.com"]],
    ["another scheme", ["ftp://reviews.example.com"]],
    ["an unknown option", ["--verbose", "http://127.0.0.1:1"]],
  ])("exits with 2 and prints the usage for %s", async (_name, args) => {
    const result = await run(args);

    expect(result.code).toBe(2);
    expect(result.err.length).toBeGreaterThan(0);
  });
});
