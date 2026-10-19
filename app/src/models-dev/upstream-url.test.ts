// SPDX-License-Identifier: Apache-2.0

// The address models.dev gives for a provider decides where a real key is sent (#548, part C), so it is untrusted
// too: https only, no credentials, and nothing that is, or resolves to, a private, loopback or link-local address.
import { describe, expect, it } from "vitest";
import {
  checkUpstreamUrl,
  nextUrlState,
  type HostResolver,
  type UrlCheck,
  type UrlRecord,
} from "./upstream-url.ts";

const PUBLIC = ["93.184.216.34"];
const resolvesTo =
  (...addresses: string[]): HostResolver =>
  async () =>
    addresses;

describe("checking an upstream address", () => {
  // #548-T07
  it.each([
    ["http://api.example.com/v1", "not_https"],
    ["ftp://api.example.com/v1", "not_https"],
    ["//api.example.com/v1", "invalid_url"],
    ["api.example.com/v1", "invalid_url"],
    ["", "invalid_url"],
    ["https://${TENANT}.example.com/v1", "invalid_url"],
    ["https://user:secret@api.example.com/v1", "credentials_in_url"],
    ["https://api.example.com/v1?key=1", "invalid_url"],
    ["https://api.example.com/v1#frag", "invalid_url"],
    ["https://localhost/v1", "private_address"],
    ["https://app.localhost/v1", "private_address"],
    ["https://intranet/v1", "private_address"],
    ["https://db.internal/v1", "private_address"],
    ["https://printer.local/v1", "private_address"],
    ["https://127.0.0.1/v1", "private_address"],
    ["https://10.1.2.3/v1", "private_address"],
    ["https://172.16.0.1/v1", "private_address"],
    ["https://192.168.1.1/v1", "private_address"],
    ["https://169.254.169.254/latest/meta-data", "private_address"],
    ["https://100.64.0.1/v1", "private_address"],
    ["https://0.0.0.0/v1", "private_address"],
    ["https://2130706433/v1", "private_address"],
    ["https://0x7f.1/v1", "private_address"],
    ["https://[::1]/v1", "private_address"],
    ["https://[fe80::1]/v1", "private_address"],
    ["https://[fd00::1]/v1", "private_address"],
    ["https://[::ffff:127.0.0.1]/v1", "private_address"],
    [`https://api.example.com/${"a".repeat(3000)}`, "too_long"],
  ])("refuses %s as %s", async (candidate, problem) => {
    const check = await checkUpstreamUrl(candidate, resolvesTo(...PUBLIC));

    expect(check).toMatchObject({ ok: false, problem });
  });

  // #548-T07
  it.each([
    ["a name that resolves to loopback", ["127.0.0.1"]],
    ["a name that resolves to a private address", ["10.0.0.7"]],
    ["a name that resolves to the metadata address", ["169.254.169.254"]],
    ["a name that resolves to an IPv6 loopback", ["::1"]],
    [
      "a name with one public and one private address",
      ["93.184.216.34", "192.168.0.9"],
    ],
    ["a name with an IPv4-mapped loopback", ["::ffff:7f00:1"]],
  ])("refuses %s", async (_name, addresses) => {
    const check = await checkUpstreamUrl(
      "https://api.example.com/v1",
      resolvesTo(...addresses),
    );

    expect(check).toMatchObject({ ok: false, problem: "private_address" });
  });

  // #548-T07
  it("says so when the name does not resolve, which is not the same as a bad address", async () => {
    const failing: HostResolver = async () => {
      throw new Error("ENOTFOUND");
    };

    expect(
      await checkUpstreamUrl("https://api.example.com/v1", failing),
    ).toMatchObject({
      ok: false,
      problem: "unresolvable",
    });
    expect(
      await checkUpstreamUrl("https://api.example.com/v1", resolvesTo()),
    ).toMatchObject({
      ok: false,
      problem: "unresolvable",
    });
  });

  // #548-T07
  it("accepts a public https address and writes it in one spelling", async () => {
    const check = await checkUpstreamUrl(
      "HTTPS://API.Example.com:443/v1/",
      resolvesTo(...PUBLIC),
    );

    expect(check).toEqual({ ok: true, url: "https://api.example.com/v1" });
  });

  // #548-T07
  it("does not resolve a name for an address that is already refused, and not for an IP literal", async () => {
    let lookups = 0;
    const counting: HostResolver = async () => {
      lookups += 1;
      return PUBLIC;
    };

    await checkUpstreamUrl("http://api.example.com/v1", counting);
    await checkUpstreamUrl("https://93.184.216.34/v1", counting);

    expect(lookups).toBe(0);
  });

  // #548-T07
  it("keeps what it was told as text for the admin, cut short, when it refuses", async () => {
    const check = await checkUpstreamUrl(
      "http://api.example.com/v1",
      resolvesTo(...PUBLIC),
    );

    expect(check).toEqual({
      ok: false,
      problem: "not_https",
      seen: "http://api.example.com/v1",
    });
  });
});

const trusted = (url: string): UrlRecord => ({
  state: "trusted",
  trustedUrl: url,
  pendingUrl: null,
  problem: null,
});
const A = "https://api.a.example/v1";
const B = "https://api.b.example/v1";
const ok = (url: string): UrlCheck => ({ ok: true, url });
const bad = (
  problem: "not_https" | "private_address" | "unresolvable" | "missing",
  seen = "x",
): UrlCheck => ({
  ok: false,
  problem,
  seen,
});

describe("the first address is trusted, a changed one is blocked until an admin confirms it", () => {
  // #548-T08
  it("trusts the first address it sees for a provider", () => {
    expect(nextUrlState(undefined, ok(A))).toEqual(trusted(A));
  });

  // #548-T08
  it("does not trust a first address that is refused, and keeps what it saw for the admin", () => {
    expect(
      nextUrlState(undefined, bad("not_https", "http://a.example")),
    ).toEqual({
      state: "rejected",
      trustedUrl: null,
      pendingUrl: "http://a.example",
      problem: "not_https",
    });
  });

  // #548-T08
  it("trusts a provider that was refused as soon as it gives an address that passes", () => {
    const rejected = nextUrlState(undefined, bad("private_address"));

    expect(nextUrlState(rejected, ok(A))).toEqual(trusted(A));
  });

  // #548-T08
  it("leaves a trusted address alone while the same address comes back", () => {
    expect(nextUrlState(trusted(A), ok(A))).toEqual(trusted(A));
  });

  // #548-T08
  it("blocks the provider when the address changes, and remembers the new one apart from the trusted one", () => {
    expect(nextUrlState(trusted(A), ok(B))).toEqual({
      state: "url_changed",
      trustedUrl: A,
      pendingUrl: B,
      problem: null,
    });
  });

  // #548-T08
  it.each(["not_https", "private_address", "missing"] as const)(
    "blocks the provider when the address changes to one that is refused (%s)",
    (problem) => {
      expect(
        nextUrlState(trusted(A), bad(problem, "http://evil.example")),
      ).toEqual({
        state: "url_changed",
        trustedUrl: A,
        pendingUrl: "http://evil.example",
        problem,
      });
    },
  );

  // #548-T08
  it("stays blocked when the new address is still there the next day", () => {
    const changed = nextUrlState(trusted(A), ok(B));

    expect(nextUrlState(changed, ok(B))).toEqual(changed);
  });

  // #548-T08
  it("follows a second change by blocking on the newest address", () => {
    const changed = nextUrlState(trusted(A), ok(B));

    expect(nextUrlState(changed, ok("https://api.c.example/v1"))).toMatchObject(
      {
        state: "url_changed",
        trustedUrl: A,
        pendingUrl: "https://api.c.example/v1",
      },
    );
  });

  // #548-T08
  it("unblocks itself when upstream goes back to the address that was trusted", () => {
    const changed = nextUrlState(trusted(A), ok(B));

    expect(nextUrlState(changed, ok(A))).toEqual(trusted(A));
  });

  // #548-T07
  it("does not block a trusted address because a name could not be resolved this time", () => {
    expect(nextUrlState(trusted(A), bad("unresolvable", A))).toEqual(
      trusted(A),
    );
  });

  // #548-T07
  it("does not trust an address on its first sight when its name cannot be resolved", () => {
    expect(nextUrlState(undefined, bad("unresolvable", A))).toMatchObject({
      state: "rejected",
      trustedUrl: null,
      problem: "unresolvable",
    });
  });
});
