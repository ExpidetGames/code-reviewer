// SPDX-License-Identifier: LicenseRef-Proprietary

// The ports of the e2e fakes (#714, #585): a fake must never get a port the kernel can hand to an outgoing connection
// (the ephemeral range, 32768-60999 on Linux), and never one that something listens on. The helper picks them below the
// range and probes them, so two fakes and a connection of the same job cannot meet on one port.
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  EPHEMERAL_FLOOR,
  ephemeralPortRange,
  pickFreePort,
} from "../../e2e/helpers/free-port.ts";

const held: Server[] = [];

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      held.push(server);
      resolve(server);
    });
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    held
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe("pickFreePort", () => {
  // #714-T01
  it("picks a port inside the range that nothing listens on", async () => {
    const port = pickFreePort({ low: 20000, high: 20999 });

    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThanOrEqual(20999);
    expect(await canBind(port)).toBe(true);
  });

  // #714-T01
  it("never picks a port that is taken, and says so when the whole range is", async () => {
    const taken = await listenOn(0);
    const { port } = taken.address() as { port: number };
    // A one-port range holding a busy port: nothing to pick. (The port is ephemeral here, which is what the
    // helper refuses for a real pick, so the range check is bypassed for this probe only.)
    expect(() =>
      pickFreePort({ low: port, high: port, allowEphemeral: true }),
    ).toThrow(/no free port/i);
  });

  // #714-T01
  it("picks consecutive ports that are all free, for a fake that takes three", async () => {
    const base = pickFreePort({ low: 21000, high: 21999, count: 3 });

    for (const offset of [0, 1, 2])
      expect(await canBind(base + offset)).toBe(true);
  });

  // #714-T01
  it("does not pick a port, or a port of a group, that the caller already holds", () => {
    const avoid = new Set<number>();
    for (let index = 0; index < 20; index += 1) {
      const base = pickFreePort({ low: 22000, high: 22099, count: 2, avoid });
      expect(avoid.has(base)).toBe(false);
      expect(avoid.has(base + 1)).toBe(false);
      avoid.add(base);
      avoid.add(base + 1);
    }
    expect(avoid.size).toBe(40);
  });

  // #714-T01
  it("refuses a range that reaches into the ephemeral range of the machine", () => {
    const { low } = ephemeralPortRange();

    expect(low).toBeLessThanOrEqual(EPHEMERAL_FLOOR);
    expect(() => pickFreePort({ low: 20000, high: low })).toThrow(/ephemeral/i);
    expect(() => pickFreePort({ low: 40000, high: 40499 })).toThrow(
      /ephemeral/i,
    );
  });
});
