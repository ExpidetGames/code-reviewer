// SPDX-License-Identifier: Apache-2.0

// A key is sent only to an address that is public at the moment of the connection (#548, #550, #555): the check made when
// the catalog is stored is a verdict of one moment, and a name can resolve elsewhere a minute later (DNS rebinding). The
// guard resolves the name itself, refuses the connection when any address is not public and hands the connect the
// addresses it vetted, so what is checked is what is connected to. The resolver and the transport are injected: no
// socket is opened.
import { EventEmitter } from "node:events";
import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  CONNECT_GUARD_BLOCKED,
  createGuardedFetch,
  createGuardedLookup,
} from "./connect-guard.ts";

const addr = (address: string, family = 4): LookupAddress => ({
  address,
  family,
});
const resolvesTo =
  (...addresses: LookupAddress[]) =>
  async () =>
    addresses;

type Answer = { error: NodeJS.ErrnoException | null; value: unknown };
function lookupOf(
  resolve: (hostname: string) => Promise<LookupAddress[]>,
  options: { all?: boolean },
): Promise<Answer> {
  return new Promise((done) => {
    createGuardedLookup(resolve)("api.example.com", options, (error, value) =>
      done({ error, value }),
    );
  });
}

describe("the lookup of a connection that carries a key", () => {
  // #548-T07
  it("hands the connect the addresses it vetted, in the form the connect asked for", async () => {
    const resolve = resolvesTo(
      addr("93.184.216.34"),
      addr("2606:4700::1111", 6),
    );

    expect(await lookupOf(resolve, { all: true })).toEqual({
      error: null,
      value: [addr("93.184.216.34"), addr("2606:4700::1111", 6)],
    });
    expect(await lookupOf(resolve, {})).toEqual({
      error: null,
      value: "93.184.216.34",
    });
  });

  // #548-T07
  it.each([
    ["loopback", ["127.0.0.1"]],
    ["the metadata address", ["169.254.169.254"]],
    ["a private address", ["10.0.0.7"]],
    ["the benchmarking range", ["198.18.0.9"]],
    ["NAT64 of loopback", ["64:ff9b::7f00:1"]],
    ["6to4 of a private address", ["2002:a00:1::1"]],
    ["one private among public addresses", ["93.184.216.34", "192.168.0.9"]],
  ])("refuses a name that resolves to %s", async (_what, addresses) => {
    for (const all of [true, false]) {
      const { error } = await lookupOf(
        resolvesTo(...addresses.map((a) => addr(a, a.includes(":") ? 6 : 4))),
        { all },
      );

      expect(error?.code).toBe(CONNECT_GUARD_BLOCKED);
    }
  });

  // #548-T07
  it("refuses a name that resolves to nothing, and passes on a failed lookup", async () => {
    expect((await lookupOf(resolvesTo(), { all: true })).error?.code).toBe(
      CONNECT_GUARD_BLOCKED,
    );

    const failing = async (): Promise<LookupAddress[]> => {
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
    expect((await lookupOf(failing, { all: true })).error?.code).toBe(
      "ENOTFOUND",
    );
  });
});

function requestStub() {
  const calls: { url: URL; options: Record<string, unknown> }[] = [];
  const request = (
    url: URL,
    options: Record<string, unknown>,
    onResponse: (
      response: EventEmitter & { statusCode?: number; resume(): void },
    ) => void,
  ) => {
    calls.push({ url, options });
    const req = new EventEmitter() as EventEmitter & {
      end(): void;
      destroy(error?: Error): void;
    };
    req.end = () => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 401,
        resume() {},
      });
      onResponse(response);
    };
    req.destroy = (error) => {
      if (error !== undefined) req.emit("error", error);
    };
    return req;
  };
  return { calls, request };
}

describe("a request that carries a key", () => {
  // #548-T07
  it("goes over https with the guarded lookup and the headers it was given, and answers with the status", async () => {
    const { calls, request } = requestStub();
    const lookup = createGuardedLookup(resolvesTo(addr("93.184.216.34")));
    const guarded = createGuardedFetch({ lookup, request });

    const response = await guarded("https://api.example.com/v1/models", {
      method: "GET",
      headers: { authorization: "Bearer sk-test" },
    });

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe("https://api.example.com/v1/models");
    expect(calls[0]?.options).toMatchObject({
      method: "GET",
      lookup,
      headers: { authorization: "Bearer sk-test" },
    });
  });

  // #548-T07
  it.each([
    "http://api.example.com/v1/models",
    "https://127.0.0.1/v1/models",
    "https://[::1]/v1/models",
    "https://10.0.0.5/v1/models",
    "https://[64:ff9b::7f00:1]/v1/models",
    "https://api.example.com:8443/v1/models",
    "https://user:pw@api.example.com/v1/models",
  ])("does not even try %s", async (url) => {
    const { calls, request } = requestStub();
    const guarded = createGuardedFetch({
      lookup: createGuardedLookup(resolvesTo(addr("93.184.216.34"))),
      request,
    });

    await expect(guarded(url, { method: "GET" })).rejects.toMatchObject({
      code: CONNECT_GUARD_BLOCKED,
    });
    expect(calls).toHaveLength(0);
  });
});
