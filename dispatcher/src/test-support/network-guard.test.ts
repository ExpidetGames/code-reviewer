// SPDX-License-Identifier: Apache-2.0

// Pins down that automated tests cannot reach the internet: the guard that Vitest installs
// for every test file rejects non-loopback hosts and leaves loopback usable, so real
// outbound requests can never slip into a unit test by accident.
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("network guard", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.end("pong");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // CR-14-T06
  it("blocks a request to an external host", async () => {
    const attempt = fetch("https://example.com");

    await expect(attempt).rejects.toMatchObject({
      cause: { code: "NETWORK_GUARD_BLOCKED" },
    });
  });

  // CR-14-T06
  it("blocks a plain http request to an external host", async () => {
    const attempt = fetch("http://203.0.113.10/");

    await expect(attempt).rejects.toMatchObject({
      cause: { code: "NETWORK_GUARD_BLOCKED" },
    });
  });

  // CR-14-T06
  it("blocks a raw socket to an external host", async () => {
    const socket = net.connect({ host: "example.com", port: 80 });

    const [error] = (await once(socket, "error")) as [NodeJS.ErrnoException];

    expect(error.code).toBe("NETWORK_GUARD_BLOCKED");
  });

  // CR-14-T06
  it("blocks a socket whose port is given as a numeric string", async () => {
    const socket = new net.Socket();
    // Node accepts a numeric string as a port, so the guard must not mistake it for a unix path.
    const connect = socket.connect.bind(socket) as unknown as (
      port: string,
      host: string,
    ) => net.Socket;
    connect("80", "203.0.113.10");

    const [error] = (await once(socket, "error")) as [NodeJS.ErrnoException];

    expect(error.code).toBe("NETWORK_GUARD_BLOCKED");
  });

  // CR-14-T06
  it("still allows requests to loopback", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`);

    expect(await response.text()).toBe("pong");
  });

  // CR-14-T06
  it("allows localhost by name", async () => {
    const response = await fetch(`http://localhost:${port}/`);

    expect(await response.text()).toBe("pong");
  });
});
