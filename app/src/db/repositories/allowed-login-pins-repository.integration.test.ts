// Pins down the allowed_login_pins repository against a real SQLite file: the first id wins, the
// key is the lower-cased login, a pre-set id replaces a pin, and unlisted logins can be cleaned up.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { createAllowedLoginPinsRepository } from "./allowed-login-pins-repository.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const clock = { now: new Date("2026-10-10T12:00:00.000Z") };
  const pins = createAllowedLoginPinsRepository(db, () => clock.now);
  return { db, pins, clock };
}

describe("pinning a login to a GitHub id", () => {
  // CR-42-T01
  it("stores the id and the time of the first pin and returns the id", async () => {
    const { pins } = await setup();

    expect(await pins.pin("octocat", "1001")).toBe("1001");

    expect(await pins.list()).toEqual([
      {
        login: "octocat",
        githubId: "1001",
        pinnedAt: "2026-10-10T12:00:00.000Z",
      },
    ]);
  });

  // CR-42-T02
  it("keeps the first id and the first time, and returns the stored id, when pinned again", async () => {
    const { pins, clock } = await setup();
    await pins.pin("octocat", "1001");
    clock.now = new Date("2026-10-11T12:00:00.000Z");

    expect(await pins.pin("octocat", "1001")).toBe("1001");
    expect(await pins.pin("octocat", "2002")).toBe("1001");

    expect(await pins.list()).toEqual([
      {
        login: "octocat",
        githubId: "1001",
        pinnedAt: "2026-10-10T12:00:00.000Z",
      },
    ]);
  });

  // CR-42-T02
  it("uses the lower-cased login as the key", async () => {
    const { pins } = await setup();
    await pins.pin("OctoCat", "1001");

    expect(await pins.pin("octocat", "2002")).toBe("1001");
    expect(await pins.find("OCTOCAT")).toBe("1001");
    expect((await pins.list()).map((pin) => pin.login)).toEqual(["octocat"]);
  });

  it("only reads when the login is bound already, so a request takes no write lock", async () => {
    const { db, pins } = await setup();
    await pins.pin("octocat", "1001");
    const statements: string[] = [];
    const watched = createAllowedLoginPinsRepository(
      db.withPlugin({
        transformQuery: ({ node }) => {
          statements.push(node.kind);
          return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
      }),
    );

    expect(await watched.pin("OctoCat", "2002")).toBe("1001");

    expect(statements).toEqual(["SelectQueryNode"]);
  });

  it("finds nothing for a login without a pin", async () => {
    const { pins } = await setup();

    expect(await pins.find("octocat")).toBeNull();
  });
});

describe("setting a pre-set id", () => {
  // CR-42-T07
  it("creates the pin when there is none", async () => {
    const { pins } = await setup();

    expect(await pins.set("OctoCat", "1001")).toBe("created");

    expect(await pins.find("octocat")).toBe("1001");
  });

  it("leaves a pin alone that already has this id", async () => {
    const { pins, clock } = await setup();
    await pins.pin("octocat", "1001");
    clock.now = new Date("2026-10-11T12:00:00.000Z");

    expect(await pins.set("octocat", "1001")).toBe("unchanged");

    expect((await pins.list())[0]?.pinnedAt).toBe("2026-10-10T12:00:00.000Z");
  });

  it("replaces a pin that has another id, with a new time", async () => {
    const { pins, clock } = await setup();
    await pins.pin("octocat", "2002");
    clock.now = new Date("2026-10-11T12:00:00.000Z");

    expect(await pins.set("octocat", "1001")).toBe("replaced");

    expect(await pins.list()).toEqual([
      {
        login: "octocat",
        githubId: "1001",
        pinnedAt: "2026-10-11T12:00:00.000Z",
      },
    ]);
  });
});

describe("removing pins of logins that are no longer listed", () => {
  // CR-42-T05
  it("deletes every pin whose login is not in the given set and keeps the others as they are", async () => {
    const { pins } = await setup();
    await pins.pin("octocat", "1001");
    await pins.pin("hubot", "3003");
    const hubot = (await pins.list()).find((pin) => pin.login === "hubot");

    expect(await pins.deleteUnlisted(new Set(["hubot"]))).toBe(1);

    expect(await pins.list()).toEqual([hubot]);
  });

  it("deletes every pin when nothing is listed", async () => {
    const { pins } = await setup();
    await pins.pin("octocat", "1001");
    await pins.pin("hubot", "3003");

    expect(await pins.deleteUnlisted(new Set())).toBe(2);

    expect(await pins.list()).toEqual([]);
  });
});
