// SPDX-License-Identifier: Apache-2.0

// The first-run setup of a serverless deployment end to end below the browser (#321): the code is made
// with `pnpm setup-code` and kept in the database, and every request may reach another instance. Each
// "instance" of the harness has its own handlers, gate and setup code store; they share the database
// and the clock and nothing else. The server mode is covered by setup.integration.test.ts, unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import type { CookieJar } from "../test-support/auth-harness.ts";
import {
  createSetupHarness,
  SETUP_TEST_ADMIN,
  SETUP_TEST_CODE,
  type SetupHarness,
} from "../test-support/setup-harness.ts";
import {
  SETUP_ATTEMPT_WINDOW_MS,
  SETUP_CODE_TTL_MS,
  SETUP_MAX_FAILURES,
} from "./code-store.ts";
import { SETUP_SESSION_TTL_MS } from "./setup-session.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A deployment: the instance that made the code with the CLI, and a way to reach "another" one. */
async function deployment() {
  const first = await createSetupHarness({ codeStore: "database" });
  const issued = await first.databaseStore?.issue();
  if (issued === undefined) throw new Error("not a database harness");
  return {
    first,
    issued,
    /** Another instance: new handlers, new gate, new state cache, the same database and clock. */
    another: () => first.restart(),
  };
}

async function enterCode(harness: SetupHarness, code = SETUP_TEST_CODE) {
  const cookies: CookieJar = new Map();
  const { response } = await harness.submitCode(code, cookies);
  expect(response.status).toBe(200);
  return cookies;
}

async function wrongCode(harness: SetupHarness) {
  const { response } = await harness.submitCode("000000");
  return { status: response.status, body: await response.json() };
}

describe("a code made by the CLI", () => {
  // #321-T01
  it("is entered on one instance, and the wizard is finished on another", async () => {
    const { first, another } = await deployment();
    const second = another();
    const third = another();

    const cookies = await enterCode(second);
    const completion = await third.complete(cookies);

    expect(completion.status).toBe(200);
    expect(await completion.json()).toEqual({ ok: true, redirectTo: "/admin" });
    const admin = await first.db
      .selectFrom("users")
      .select(["email", "is_instance_admin"])
      .executeTakeFirstOrThrow();
    expect(admin).toMatchObject({ email: SETUP_TEST_ADMIN.email });
  });

  // #321-T01
  it("makes the setup disappear on every instance once it is complete, and removes the code", async () => {
    const { first, another } = await deployment();
    const cookies = await enterCode(another());
    await another().complete(cookies);

    for (const instance of [first, another(), another()]) {
      const page = await instance.visit("/setup");
      const code = await instance.submitCode(SETUP_TEST_CODE);
      expect(page.status).toBe(404);
      expect(code.response.status).toBe(404);
    }
    expect(
      await first.db.selectFrom("setup_codes").select("id").execute(),
    ).toEqual([]);
  });

  // #321-T01
  it("shows the code form on an instance that did not issue the code, and nothing else of the app", async () => {
    const { another } = await deployment();
    const instance = another();

    const page = await instance.visit("/projects");
    const api = await instance.visit("/api/projects");

    expect(await page.text()).toBe("setup-page");
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: "setup_required" });
  });

  // #321-T01
  it("answers setup_unavailable on every instance until a code was made", async () => {
    const harness = await createSetupHarness({ codeStore: "database" });

    for (const instance of [harness, harness.restart()]) {
      const { response } = await instance.submitCode(SETUP_TEST_CODE);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "setup_unavailable" });
    }
  });

  // #321-T01
  it("ends a setup session when a new code is made, on every instance", async () => {
    const { first, another } = await deployment();
    const second = another();
    const cookies = await enterCode(second);

    await first.databaseStore?.issue();

    const completion = await another().complete(cookies);
    expect(completion.status).toBe(401);
    expect(await completion.json()).toEqual({
      error: "setup_session_required",
    });
  });

  // #321-T01
  it("lets a setup session run out after 30 minutes on any instance", async () => {
    const { first, another } = await deployment();
    const cookies = await enterCode(another());

    first.advance(SETUP_SESSION_TTL_MS);

    const completion = await another().complete(cookies);
    expect(completion.status).toBe(401);
    expect(await completion.json()).toEqual({ error: "setup_session_expired" });
  });

  // #321-T01
  it("refuses a setup session without a code made after it, and one forged without the code", async () => {
    const { another } = await deployment();

    const completion = await another().complete(new Map());

    expect(completion.status).toBe(401);
    expect(await completion.json()).toEqual({
      error: "setup_session_required",
    });
  });
});

describe("wrong codes", () => {
  // #321-T02
  it("are counted in the database: ten of them, on any instances, lock the setup everywhere", async () => {
    const { first, another } = await deployment();
    const instances = [first, another(), another()];

    const answers = [];
    for (let attempt = 0; attempt < SETUP_MAX_FAILURES; attempt += 1) {
      answers.push(await wrongCode(instances[attempt % 3] as SetupHarness));
      first.advance(SETUP_ATTEMPT_WINDOW_MS);
    }

    expect(answers.every((a) => a.status === 403)).toBe(true);
    for (const instance of [...instances, another()]) {
      const { response } = await instance.submitCode(SETUP_TEST_CODE);
      expect(response.status).toBe(423);
      expect(await response.json()).toEqual({ error: "setup_locked" });
    }
    const row = await first.db
      .selectFrom("setup_codes")
      .select("failures")
      .executeTakeFirstOrThrow();
    expect(row.failures).toBe(SETUP_MAX_FAILURES);
  });

  // #321-T02
  it("are limited to five a minute for the deployment, with Retry-After", async () => {
    const { first, another } = await deployment();
    const instances = [first, another()];

    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(
        (await wrongCode(instances[attempt % 2] as SetupHarness)).status,
      ).toBe(403);

    const { response } = await (instances[1] as SetupHarness).submitCode(
      SETUP_TEST_CODE,
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThanOrEqual(
      1,
    );
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  // #321-T02
  it("stay locked, whatever the time, until the CLI makes a new code", async () => {
    const { first, another } = await deployment();
    for (let attempt = 0; attempt < SETUP_MAX_FAILURES; attempt += 1) {
      await wrongCode(first);
      first.advance(SETUP_ATTEMPT_WINDOW_MS);
    }
    first.advance(SETUP_CODE_TTL_MS / 4);
    expect((await another().submitCode(SETUP_TEST_CODE)).response.status).toBe(
      423,
    );

    await first.databaseStore?.issue();

    expect((await another().submitCode(SETUP_TEST_CODE)).response.status).toBe(
      200,
    );
  });
});

describe("expired and used codes", () => {
  // #321-T03
  it("are refused on every instance: expired with 410", async () => {
    const { first, another } = await deployment();

    first.advance(SETUP_CODE_TTL_MS);

    for (const instance of [first, another()]) {
      const { response } = await instance.submitCode(SETUP_TEST_CODE);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "code_expired" });
    }
  });

  // #321-T03
  it("are refused on every instance: used with 409, and the second browser gets no session", async () => {
    const { first, another } = await deployment();
    await enterCode(another());
    first.advance(SETUP_ATTEMPT_WINDOW_MS);

    for (const instance of [first, another()]) {
      const cookies: CookieJar = new Map();
      const { response } = await instance.submitCode(SETUP_TEST_CODE, cookies);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "code_used" });
      expect(cookies.size).toBe(0);
    }
  });

  // #321-T03
  it("give exactly one of several browsers on different instances a session when they submit together", async () => {
    const { another } = await deployment();
    const instances = Array.from({ length: 5 }, () => another());

    const answers = await Promise.all(
      instances.map(async (instance) => {
        const { response } = await instance.submitCode(SETUP_TEST_CODE);
        return response.status;
      }),
    );

    expect(answers.filter((status) => status === 200)).toHaveLength(1);
    expect(answers.filter((status) => status === 409)).toHaveLength(4);
  });
});

describe("the code stays on the operator's terminal", () => {
  // #321-T05
  it("is in no response, header, log line or console output of any instance, and not in the database", async () => {
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const infos = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { first, another } = await deployment();
    const second = another();

    const seen: string[] = [];
    for (const instance of [first, second])
      for (const [path, method] of [
        ["/", "GET"],
        ["/setup", "GET"],
        ["/api/projects", "GET"],
        ["/api/health", "GET"],
      ] as const) {
        const response = await instance.visit(path, { method });
        seen.push(await response.text(), [...response.headers].join("\n"));
      }
    const wrong = await second.submitCode("000000");
    seen.push(
      await wrong.response.text(),
      [...wrong.response.headers].join("\n"),
    );
    const right = await first.submitCode(SETUP_TEST_CODE);
    seen.push(
      await right.response.text(),
      [...right.response.headers].join("\n"),
    );

    expect(seen.join("\n")).not.toContain(SETUP_TEST_CODE);
    expect([...first.logs, ...second.logs].join("\n")).not.toContain(
      SETUP_TEST_CODE,
    );
    expect(
      JSON.stringify([errors.mock.calls, infos.mock.calls, logs.mock.calls]),
    ).not.toContain(SETUP_TEST_CODE);
    const rows = await first.db.selectFrom("setup_codes").selectAll().execute();
    expect(JSON.stringify(rows)).not.toContain(SETUP_TEST_CODE);
  });
});

describe("a server", () => {
  // #321-T04
  it("keeps its code in memory: the table stays empty and the printed code is the only one that works", async () => {
    const harness = await createSetupHarness();
    const start = await harness.start();
    const cookies: CookieJar = new Map();
    const { response } = await harness.submitCode(SETUP_TEST_CODE, cookies);
    const completion = await harness.complete(cookies);

    expect(start.printed).toHaveLength(1);
    expect(response.status).toBe(200);
    expect(completion.status).toBe(200);
    expect(
      await harness.db.selectFrom("setup_codes").select("id").execute(),
    ).toEqual([]);
  });

  // #321-T04
  it("does not read a code from the database, even one a CLI wrote there", async () => {
    const harness = await createSetupHarness();
    await harness.start();
    // The same table in the server's database, as if somebody ran the CLI against it by mistake.
    const issued = await createServerCliCode(harness);

    const { response } = await harness.submitCode(issued);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_code" });
  });
});

/** Writes a database code into the database of `harness` the way the CLI would, and returns it. */
async function createServerCliCode(harness: SetupHarness): Promise<string> {
  const { createDatabaseSetupCodeStore } =
    await import("./database-code-store.ts");
  const { SETUP_TEST_SECRET } =
    await import("../test-support/setup-harness.ts");
  const store = createDatabaseSetupCodeStore({
    db: harness.db,
    appSecret: SETUP_TEST_SECRET,
    randomCode: () => "246810",
  });
  return (await store.issue()).code;
}

// Not set up although the settings exist: the CLI's refusal is in setup-code-cli.integration.test.ts.
describe("an instance that is set up", () => {
  // #321-T06
  it("has no setup routes on any instance, even with a code row left behind", async () => {
    const { first, another } = await deployment();
    await createInstanceSettingsRepository(first.db).set(
      "setup_completed_at",
      "2026-10-11T07:00:00.000Z",
      null,
    );

    for (const instance of [first, another()]) {
      const { response } = await instance.submitCode(SETUP_TEST_CODE);
      expect(response.status).toBe(404);
    }
  });
});
