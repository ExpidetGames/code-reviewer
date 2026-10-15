// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { Clock } from "../core/types.ts";
import { DISPATCHER_TOKEN } from "../test-support/harness.ts";
import { parseCanaryArguments, runCanary } from "./canary.ts";

type Seen = { url: string; method: string; headers: Headers };

function script(handler: (request: Seen) => Response | Promise<Response>): {
  fetch: typeof fetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const entry = {
        url: request.url,
        method: request.method,
        headers: request.headers,
      };
      seen.push(entry);
      return handler(entry);
    },
  };
}

/** Time does not pass in a test: every wait ends at once, the number of tries is what counts. */
const instantClock: Clock = { sleep: () => Promise.resolve() };

const REPORT = {
  version: 1,
  status: "passed",
  ok: true,
  engines: ["pr-agent", "opencode"],
  reasons: [],
  checkedAt: "2026-10-15T12:00:00.000Z",
};

function respond(report: unknown, status = 200): Response {
  return new Response(JSON.stringify(report), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers /health with 200 and /probe with the given response. */
function deployment(probe: () => Response | Promise<Response>) {
  return script((request) =>
    request.url.endsWith("/health") ? respond({ status: "ok" }) : probe(),
  );
}

function options(
  fetchImplementation: typeof fetch,
  extra: Partial<Parameters<typeof runCanary>[0]> = {},
) {
  const lines: string[] = [];
  return {
    lines,
    run: () =>
      runCanary({
        url: "https://dispatcher.example",
        token: DISPATCHER_TOKEN,
        fetch: fetchImplementation,
        clock: instantClock,
        write: (line) => lines.push(line),
        ...extra,
      }),
  };
}

describe("the deploy canary", () => {
  // #331-T01
  it("passes when the deployment's canary passed and advertises both engines", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));
    const { run, lines } = options(fetch);

    expect(await run()).toBe(0);

    const probe = seen.find((request) => request.url.endsWith("/probe"));
    expect(probe?.method).toBe("POST");
    expect(probe?.url).toBe("https://dispatcher.example/probe");
    expect(probe?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    expect(lines.join("\n")).toContain("passed");
    expect(lines.join("\n")).not.toContain(DISPATCHER_TOKEN);
  });

  // #331-T02
  it("blocks the release when the canary was denied, and names the stable reasons only", async () => {
    const denied = {
      ...REPORT,
      status: "denied",
      ok: false,
      engines: ["pr-agent"],
      reasons: [
        "ipv6_not_disabled",
        "ghp_" + "0123456789abcdef0123456789abcdef0123",
      ],
      detail: "text the Dispatcher would never send",
    };
    const { fetch } = deployment(() => respond(denied, 503));
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);

    const text = lines.join("\n");
    expect(text).toContain("denied");
    expect(text).toContain("ipv6_not_disabled");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("never send");
  });

  // #331-T02
  it("blocks the release when the canary could not run, with the failure code", async () => {
    const failed = {
      ...REPORT,
      status: "failed",
      ok: false,
      engines: ["pr-agent"],
      failure: "probe_timeout",
    };
    const { fetch } = deployment(() => respond(failed, 503));
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);
    expect(lines.join("\n")).toContain("probe_timeout");
  });

  // #331-T02
  it("blocks the release when a deployment that is not configured for Dynamic is asked to prove it", async () => {
    const diffOnly = {
      ...REPORT,
      engines: ["pr-agent"],
      status: "denied",
      ok: true,
      reasons: ["not_a_dynamic_runner"],
    };
    const { fetch } = deployment(() => respond(diffOnly));

    expect(await options(fetch).run()).toBe(1);
  });

  // #331-T01
  it("passes a Diff-only deployment when only PR-Agent is required", async () => {
    const diffOnly = {
      ...REPORT,
      engines: ["pr-agent"],
      status: "denied",
      ok: true,
      reasons: ["not_a_dynamic_runner"],
    };
    const { fetch } = deployment(() => respond(diffOnly));

    expect(await options(fetch, { requiredEngines: ["pr-agent"] }).run()).toBe(
      0,
    );
  });

  // #331-T05
  it("blocks the release on a refused credential without saying more than the status", async () => {
    const { fetch } = deployment(() =>
      respond(
        {
          error: {
            code: "RUNNER_UNAUTHORIZED",
            message: "The request could not be verified.",
          },
        },
        401,
      ),
    );
    const { run, lines } = options(fetch);

    expect(await run()).toBe(1);
    expect(lines.join("\n")).toContain("401");
  });

  // #331-T08
  it.each([
    [
      "an answer that is not JSON",
      () => new Response("<html>login</html>", { status: 200 }),
    ],
    ["JSON of another shape", () => respond({ hello: "world" })],
    [
      "a report that says ok and advertises nothing",
      () => respond({ ...REPORT, engines: [] }),
    ],
    [
      "a redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/probe" },
        }),
    ],
  ])("blocks the release on %s", async (_name, answer) => {
    const { fetch, seen } = deployment(answer);

    expect(await options(fetch).run()).toBe(1);
    expect(seen.map((request) => new URL(request.url).host)).toStrictEqual([
      "dispatcher.example",
      "dispatcher.example",
    ]);
  });

  // #331-T02
  it("blocks the release when the deployment cannot be reached", async () => {
    const { run, lines } = options(() =>
      Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:443")),
    );

    expect(await run()).toBe(1);
    expect(lines.join("\n")).toContain("deployment_not_ready");
    expect(lines.join("\n")).not.toContain("10.0.0.1");
  });

  // #331-T02
  it("waits for the new deployment to answer before it sends the credential, and never sends it to /health", async () => {
    let health = 0;
    const { fetch, seen } = script((request) => {
      if (request.url.endsWith("/health")) {
        health += 1;
        return health < 3
          ? new Response("not yet", { status: 404 })
          : respond({ status: "ok" });
      }
      return respond(REPORT);
    });
    const { run } = options(fetch, { healthWaitSeconds: 60 });

    expect(await run()).toBe(0);

    expect(health).toBe(3);
    for (const request of seen.filter((entry) => entry.url.endsWith("/health")))
      expect(request.headers.get("authorization")).toBeNull();
  });

  // #331-T05
  it("sends no credential when the deployment never answers", async () => {
    const { fetch, seen } = script(() => new Response("no", { status: 404 }));

    expect(await options(fetch, { healthWaitSeconds: 20 }).run()).toBe(1);

    expect(
      seen.every((request) => request.headers.get("authorization") === null),
    ).toBe(true);
    expect(seen.some((request) => request.url.endsWith("/probe"))).toBe(false);
  });

  // #331-T05
  it("does not send the credential over plain http, except to this machine", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));

    expect(
      await options(fetch, { url: "http://dispatcher.example" }).run(),
    ).toBe(2);
    expect(seen).toStrictEqual([]);
    expect(await options(fetch, { url: "http://127.0.0.1:8080" }).run()).toBe(
      0,
    );
  });

  // #331-T02
  it("passes the deployment-protection bypass secret as a header and never prints it", async () => {
    const { fetch, seen } = deployment(() => respond(REPORT));
    const { run, lines } = options(fetch, {
      bypassSecret: "dummy-bypass-secret-value",
    });

    await run();

    expect(
      seen.every(
        (request) =>
          request.headers.get("x-vercel-protection-bypass") ===
          "dummy-bypass-secret-value",
      ),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain("dummy-bypass-secret-value");
  });
});

describe("the arguments of the deploy canary", () => {
  it("takes the URL and reads the credential from the environment, never from an argument", () => {
    expect(
      parseCanaryArguments(["--url", "https://d.example"], {
        RUNNER_TOKEN: "dummy-token-1234567890",
      }),
    ).toMatchObject({
      url: "https://d.example",
      token: "dummy-token-1234567890",
      requiredEngines: ["pr-agent", "opencode"],
    });
    expect(() =>
      parseCanaryArguments(["--url", "https://d.example", "--token", "x"], {}),
    ).toThrow(/usage/i);
  });

  it("needs the URL and the credential", () => {
    expect(() =>
      parseCanaryArguments([], { RUNNER_TOKEN: "dummy-token-1234567890" }),
    ).toThrow(/--url/);
    expect(() =>
      parseCanaryArguments(["--url", "https://d.example"], {}),
    ).toThrow(/RUNNER_TOKEN/);
  });

  it("accepts the engines to require and the time to wait", () => {
    const parsed = parseCanaryArguments(
      [
        "--url",
        "https://d.example",
        "--engines",
        "pr-agent",
        "--wait-seconds",
        "90",
      ],
      {
        RUNNER_TOKEN: "dummy-token-1234567890",
        VERCEL_AUTOMATION_BYPASS_SECRET: "dummy-bypass",
      },
    );

    expect(parsed).toMatchObject({
      requiredEngines: ["pr-agent"],
      healthWaitSeconds: 90,
      bypassSecret: "dummy-bypass",
    });
  });
});
